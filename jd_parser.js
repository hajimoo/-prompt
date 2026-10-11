/**
 * 직무기술서(JD) PDF 파서
 * - pdf.js 텍스트 아이템의 좌표(x, y)로 줄을 복원한 뒤, 회사별 프로필로 직무를 분리합니다.
 * - 삼성전자 DS부문: 페이지 상단 "사업부 > 직무" 헤더 + Role / Recommended Subject / Requirements / Pluses / Career Vision
 * - DN솔루션즈: 1직무 1페이지 표 형식 (직무 요약 / Role & Responsibility / Career Vision / 유관전공 및 학위 / 우대 사항)
 * - 그 외: 섹션 제목 기반 일반 파서 (fallback)
 * 브라우저(window.JDParser)와 Node(module.exports) 양쪽에서 동작합니다.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. pdf.js → 좌표가 있는 아이템 목록
  // ---------------------------------------------------------------------------
  async function extractPdfPages(pdf) {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter(it => typeof it.str === 'string' && it.str.length > 0)
        .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
      pages.push({ pageNum: i, items });
    }
    return pages;
  }

  const clean = s => (s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/([A-Za-z]) -([A-Za-z])/g, '$1-$2')      // "Turn -key" → "Turn-key"
    .replace(/(\d) (축|차|년|급|월|일|nm)(?=[\s/,)]|$)/g, '$1$2')   // "5 축" → "5축"
    .trim();

  /** 같은 y(±tol)의 아이템을 한 줄로 묶어 위→아래, 왼→오 순으로 반환 */
  function groupRows(items, tol = 3, implicitSpace = false) {
    const rows = [];
    for (const it of items) {
      let row = rows.find(r => Math.abs(r.y - it.y) <= tol);
      if (!row) rows.push(row = { y: it.y, items: [] });
      row.items.push(it);
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let joined = '';
      r.items.forEach((it, k) => {
        if (k > 0 && implicitSpace) {
          const prevS = r.items[k - 1].str;
          // 공백 아이템 없이 붙어 있는 두 단어 사이에 띄어쓰기 복원 (DN 등 글자간격형 PDF)
          if (/[가-힣A-Za-z0-9)\]]$/.test(prevS) && /^[가-힣A-Za-z0-9(]/.test(it.str)) joined += ' ';
        }
        joined += it.str;
      });
      const text = clean(joined);
      const firstVisible = r.items.find(i => i.str.trim());
      return { y: r.y, x: firstVisible ? firstVisible.x : 0, text };
    }).filter(r => r.text);
  }

  const pageText = p => groupRows(p.items).map(r => r.text).join('\n');

  // ---------------------------------------------------------------------------
  // 2. 회사 감지
  // ---------------------------------------------------------------------------
  const COMPANY_RULES = [
    { id: 'samsung', name: '삼성전자 DS부문', test: t => /삼성전자\s*DS|SAMSUNG|삼성전자/.test(t) },
    { id: 'dn', name: 'DN솔루션즈', test: t => /DN\s*솔루션즈|디엔솔루션즈|DN Solutions/i.test(t) },
    { id: 'skhynix', name: 'SK하이닉스', test: t => /SK\s*하이닉스|SK hynix/i.test(t) },
    { id: 'hyundai', name: '현대자동차', test: t => /현대자동차/.test(t) },
    { id: 'lg', name: 'LG전자', test: t => /LG전자/.test(t) }
  ];

  function detectCompany(pages) {
    const head = pages.slice(0, 3).map(pageText).join('\n');
    const hit = COMPANY_RULES.find(r => r.test(head));
    return hit ? { id: hit.id, name: hit.name } : { id: 'generic', name: '' };
  }

  // ---------------------------------------------------------------------------
  // 3. 공통 스키마
  // ---------------------------------------------------------------------------
  function newJob(o) {
    return Object.assign({
      id: '', company: '', division: '', job: '', dept: '', location: '',
      title: '', pages: [], pageRange: '',
      summary: '',
      roles: [],              // [{ title, items: [] }]
      subjectsByMajor: {},    // { '기계': '고체역학, ...' }
      majorsRequired: [],     // DN '유관전공 및 학위' / 일반 '지원 자격'
      requirements: [],
      pluses: [],
      careerVision: [],
      eligibleMajors: '',     // 삼성 모집표의 모집전공 원문
      source: 'parser'
    }, o);
  }

  function finalizeJob(j) {
    j.pages = Array.from(new Set(j.pages)).sort((a, b) => a - b);
    const s = j.pages[0], e = j.pages[j.pages.length - 1];
    j.pageRange = s === e ? `p.${s}` : `p.${s}~${e}`;
    return j;
  }

  /** "- 항목" 줄 목록을 항목 배열로 (줄바꿈된 이어지는 줄은 앞 항목에 합침) */
  function linesToBullets(lines) {
    const out = [];
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      if (/^[-•▪·∙]\s*/.test(t) || out.length === 0) out.push(t.replace(/^[-•▪·∙]\s*/, ''));
      else out[out.length - 1] += ' ' + t;
    }
    return out.map(clean).filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // 4. 삼성전자 DS부문 프로필
  // ---------------------------------------------------------------------------
  const SS_HEADER = /^(.+?(?:사업부|연구소|총괄|센터|부문))\s*[>›»]\s*(.+)$/;
  const SS_SECTION = {
    'Role': 'role',
    'Recommended Subject': 'subject',
    'Requirements': 'req',
    'Pluses': 'plus',
    'Career Vision': 'vision'
  };
  const SUBJECT_LABEL = /^(전기전자\s*\(HW\)|재료\s*\/\s*금속|화학\s*\/\s*화공|기계|물리|전산\s*\/\s*컴퓨터|산업공학|수학\s*\/\s*통계|환경|안전보건)$/;

  function normMajorLabel(s) {
    return clean(s).replace(/\s*\/\s*/g, '/').replace(/\s*\(\s*/g, '(');
  }

  function parseSamsung(pages, companyName) {
    const jobs = new Map();
    let order = 0;

    for (const p of pages) {
      const rows = groupRows(p.items);
      const headerIdx = rows.findIndex(r => SS_HEADER.test(r.text));
      if (headerIdx < 0) continue;
      const m = rows[headerIdx].text.match(SS_HEADER);
      const division = clean(m[1]);
      const jobName = clean(m[2]);
      const key = `${division} > ${jobName}`;
      if (!jobs.has(key)) {
        jobs.set(key, { job: newJob({
          id: `ss-${order++}`, company: companyName, division, job: jobName, title: key
        }), state: 'meta', summaryLines: [], buf: { role: [], subject: [], req: [], plus: [], vision: [] } });
      }
      const ctx = jobs.get(key);
      ctx.job.pages.push(p.pageNum);

      rows.forEach((r, idx) => {
        if (idx === headerIdx) return;
        const t = r.text;
        if (SS_SECTION[t]) { ctx.state = SS_SECTION[t]; return; }
        if (ctx.state === 'meta') {
          let mm;
          if ((mm = t.match(/^근무지\s*:\s*(.+)$/))) { ctx.job.location = clean(mm[1]); return; }
          if (/^직무\s*:/.test(t)) return;
          if (/\((?:[A-Za-z/&\s.-]*(?:Business|Center|PKG))\)\s*$/.test(t) && t.length < 60) return; // 사업부 배지
          if (/^Job Description$/i.test(t)) return;
          ctx.summaryLines.push(t);
          return;
        }
        ctx.buf[ctx.state].push(r);
      });
    }

    const out = [];
    for (const { job, summaryLines, buf } of jobs.values()) {
      job.summary = clean(summaryLines.join(' '));

      // Role: "-" 없는 줄은 소제목(x가 bullet보다 작음) 또는 앞 bullet의 줄바꿈
      let cur = null;
      for (const r of buf.role) {
        const isBullet = /^-/.test(r.text);
        if (isBullet) {
          if (!cur) job.roles.push(cur = { title: '', items: [] });
          cur.items.push(clean(r.text.replace(/^-\s*/, '')));
        } else if (cur && cur.items.length && r.x > 43) {
          cur.items[cur.items.length - 1] += ' ' + r.text;
        } else {
          job.roles.push(cur = { title: r.text, items: [] });
        }
      }

      // Recommended Subject: 전공 라벨 → 과목 줄
      let label = null;
      for (const r of buf.subject) {
        if (SUBJECT_LABEL.test(r.text)) { label = normMajorLabel(r.text); job.subjectsByMajor[label] = ''; continue; }
        if (label) job.subjectsByMajor[label] = clean((job.subjectsByMajor[label] + ' ' + r.text));
      }

      job.requirements = linesToBullets(buf.req.map(r => r.text));
      job.pluses = linesToBullets(buf.plus.map(r => r.text));
      job.careerVision = linesToBullets(buf.vision.map(r => r.text));
      out.push(finalizeJob(job));
    }

    attachSamsungEligibleMajors(pages, out);
    return out;
  }

  /** 삼성 2쪽 모집표(사업부/직무/모집전공/근무지)에서 직무별 모집전공을 읽어 붙입니다. */
  function attachSamsungEligibleMajors(pages, jobs) {
    const tablePage = pages.slice(0, 4).find(p => /모집전공/.test(pageText(p)));
    if (!tablePage) return;
    const its = tablePage.items.filter(i => i.str.trim());
    const header = its.find(i => /모집전공/.test(i.str));
    const locHeader = its.find(i => /근무지/.test(i.str));
    if (!header) return;
    const majorX0 = header.x - 160, majorX1 = locHeader ? locHeader.x - 40 : header.x + 200;

    // 직무명 셀: 직무 목록에 있는 이름과 일치하는 아이템
    const jobNames = Array.from(new Set(jobs.map(j => j.job)));
    const nameCells = its
      .filter(i => i.y < header.y - 5 && jobNames.includes(clean(i.str)))
      .sort((a, b) => b.y - a.y);
    const majorItems = its.filter(i => i.y < header.y - 5 && i.x >= majorX0 && i.x < majorX1 && !jobNames.includes(clean(i.str)));

    const cells = nameCells.map(n => ({ name: clean(n.str), y: n.y, parts: [] }));
    for (const mi of majorItems) {
      let best = null, bd = Infinity;
      for (const c of cells) { const d = Math.abs(c.y - mi.y); if (d < bd) { bd = d; best = c; } }
      if (best && bd < 22) best.parts.push(mi);
    }
    // 표 행 순서 == 본문 직무 순서 (삼성 JD 공통 구성)
    const queue = jobs.slice();
    for (const c of cells) {
      const idx = queue.findIndex(j => j.job === c.name);
      if (idx < 0) continue;
      const j = queue.splice(idx, 1)[0];
      const text = groupRows(c.parts, 4).map(r => r.text).join(' ');
      j.eligibleMajors = clean(text).replace(/,\s*$/, '');
    }
  }

  // ---------------------------------------------------------------------------
  // 5. DN솔루션즈 프로필 (표 형식, 1직무 1페이지)
  // ---------------------------------------------------------------------------
  const DN_TITLE = /^(R&D|생산\s*\/\s*품질|영업|경영지원)\s*[–—-]\s*(.+)$/;
  const LABEL_COL_MAX = 140;   // 왼쪽 라벨 열 (직무 요약, Role & Responsibility, Career Vision, 요건)

  /**
   * 표 셀의 라벨은 셀 세로 중앙에 놓인다는 성질을 이용해 content row를 섹션으로 나눈다.
   * rows: 위→아래 정렬된 content row, labelYs: 각 섹션 라벨의 y (위→아래)
   * 각 그룹의 (맨 위 y + 맨 아래 y)/2 가 라벨 y에 가장 가까워지는 경계 조합을 고른다.
   * @returns {Array<Array<row>>} labelYs 개수만큼의 그룹
   */
  function splitByLabelCenters(rows, labelYs) {
    const n = rows.length, k = labelYs.length;
    if (k <= 1 || n === 0) return [rows.slice()].concat(Array.from({ length: Math.max(0, k - 1) }, () => []));
    const cost = (a, b, ly) => {           // rows[a..b) 를 라벨 ly 의 셀로 볼 때 비용
      if (b <= a) return 400;              // 빈 셀은 큰 벌점
      const center = (rows[a].y + rows[b - 1].y) / 2;
      return Math.abs(center - ly);
    };
    // DP: best[g][i] = 앞 i개 row를 g개 그룹으로 나눌 때 최소 비용
    const INF = 1e9;
    const best = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(INF));
    const prev = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(-1));
    best[0][0] = 0;
    for (let g = 1; g <= k; g++) {
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= i; j++) {
          if (best[g - 1][j] >= INF) continue;
          const c = best[g - 1][j] + cost(j, i, labelYs[g - 1]);
          if (c < best[g][i]) { best[g][i] = c; prev[g][i] = j; }
        }
      }
    }
    const groups = [];
    let i = n;
    for (let g = k; g >= 1; g--) { const j = prev[g][i]; groups.unshift(rows.slice(j, i)); i = j; }
    return groups;
  }

  /** "▪ 제목" / "- 항목" 줄을 roles 구조로 (제목·줄바꿈 판별은 행 간격 사용) */
  function rowsToRoles(rows) {
    const roles = [];
    let cur = null;
    for (const r of rows) {
      if (/^[-–]\s*/.test(r.text) && !/^[-–]\s*$/.test(r.text)) {
        if (!cur) roles.push(cur = { title: '', items: [] });
        cur.items.push(clean(r.text.replace(/^[-–]\s*/, '')));
      } else {
        // DN 표는 칸이 넓어 항목이 줄바꿈되는 경우가 없음 → '-' 없는 줄은 소제목
        roles.push(cur = { title: clean(r.text.replace(/^[▪■•●·]\s*/, '')), items: [] });
      }
    }
    return roles.filter(r => r.title || r.items.length);
  }

  function parseDN(pages, companyName) {
    const out = [];
    for (const p of pages) {
      const its = p.items.filter(i => !(i.y < 24 && i.x > 480)); // footer "Internal Use Only | n"
      const allRows = groupRows(its);
      const titleRow = allRows.find(r => DN_TITLE.test(r.text));
      const groupRow = allRows.find(r => /^Job Group/.test(r.text));
      if (!titleRow || !groupRow) continue;

      const tm = titleRow.text.match(DN_TITLE);
      const meta = groupRow.text.match(/Job Group\s*(.+?)\s*근무\s*부서\s*(.+?)\s*근무지\s*(.+)$/);
      const job = newJob({
        id: `dn-${out.length}`, company: companyName,
        division: clean(tm[1]).replace(/\s*\/\s*/, '/'),
        job: clean(tm[2]),
        dept: meta ? clean(meta[2]) : '',
        location: meta ? clean(meta[3]) : '',
        pages: [p.pageNum]
      });
      job.title = `${job.division} – ${job.job}`;

      // 본문 영역 (제목/Job Group 아래)
      const body = its.filter(i => i.y < groupRow.y - 6);

      // 라벨 위치 찾기 (라벨 열의 아이템만 사용)
      const labelRows = groupRows(body.filter(i => i.x < 230 && /[가-힣A-Za-z&]/.test(i.str) &&
        (i.x < LABEL_COL_MAX || /^(유관전공|및|학위|우대|사항|유관전공 및 학위|우대 사항)$/.test(clean(i.str)))));
      const findLabelY = re => { const r = labelRows.find(r => re.test(r.text)); return r ? r.y : null; };
      const ySummary = findLabelY(/직무\s*요약|^요약$/);
      const yRoleA = findLabelY(/^Role/);
      const yRoleB = findLabelY(/Responsibility/);
      const yRole = (yRoleA !== null && yRoleB !== null) ? (yRoleA + yRoleB) / 2 : (yRoleA !== null ? yRoleA : yRoleB);
      const yVision = findLabelY(/Career\s*Vision/);
      const yMajor = findLabelY(/유관전공/);
      const yPlus = findLabelY(/우대/);

      // 라벨 아이템 제거 → 내용 아이템만
      const isLabelItem = i => {
        const s = clean(i.str);
        if (i.x < LABEL_COL_MAX && /^(직무|요약|직무 요약|Role|&|Role &|Responsibility|Career|Vision|Career Vision|요|건|요건|요 건)$/.test(s)) return true;
        const nearSubLabel = [yMajor, yPlus].some(y => y !== null && Math.abs(i.y - y) < 3);
        if (nearSubLabel && i.x >= 140 && i.x < 230 && /^(유관전공|및|학위|유관전공 및 학위|우대|사항|우대 사항)$/.test(s)) return true;
        return false;
      };
      const content = body.filter(i => !isLabelItem(i) && !(i.str.trim() === '' && i.x < LABEL_COL_MAX));
      const REQ_X = 255;   // 요건 열의 내용은 x≈271에서 시작
      const contentRows = groupRows(content, 3, true);
      const mainRows = contentRows.filter(r => r.x < REQ_X);
      const reqRows = contentRows.filter(r => r.x >= REQ_X);

      const mainLabels = [ySummary, yRole, yVision].filter(v => v !== null);
      const [sumRows = [], roleRows = [], visRows = []] = mainLabels.length === 3
        ? splitByLabelCenters(mainRows, mainLabels)
        : [[], mainRows, []];

      job.summary = clean(sumRows.map(r => r.text).join(' '));
      job.roles = rowsToRoles(roleRows);
      // Career Vision: 첫 줄(굵은 제목)이 '-'가 아니면 항목으로 함께 담음
      job.careerVision = linesToBullets(visRows.map((r, i) => (i === 0 && !/^-/.test(r.text)) ? '- ' + r.text : r.text));

      const [majorRows = [], plusRows = []] = (yMajor !== null && yPlus !== null)
        ? splitByLabelCenters(reqRows, [yMajor, yPlus])
        : [reqRows, []];
      job.majorsRequired = linesToBullets(majorRows.map(r => r.text));
      job.pluses = linesToBullets(plusRows.map(r => r.text));
      job.requirements = job.majorsRequired.filter(s => !/^(전공|학위)\s*:/.test(s));
      job.eligibleMajors = (job.majorsRequired.find(s => /^전공\s*:/.test(s)) || '').replace(/^전공\s*:\s*/, '');

      out.push(finalizeJob(job));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 6. 일반 fallback (섹션 제목 기반)
  // ---------------------------------------------------------------------------
  const GENERIC_MARKERS = [
    { type: 'summary', re: /^(직무\s*요약|직무\s*소개|Job\s*Summary)\s*[:：]?\s*(.*)$/i },
    { type: 'role', re: /^(Role(\s*&\s*Responsibility)?|담당\s*업무|주요\s*업무|수행\s*업무|직무\s*내용)\s*[:：]?\s*(.*)$/i },
    { type: 'subject', re: /^(Recommended\s*Subject|추천\s*(이수)?\s*과목|관련\s*교과)\s*[:：]?\s*(.*)$/i },
    { type: 'req', re: /^(Requirements?|지원\s*자격|필수\s*요건|자격\s*요건|유관\s*전공(\s*및\s*학위)?)\s*[:：]?\s*(.*)$/i },
    { type: 'plus', re: /^(Pluses?|Preferred|우대\s*사항|우대\s*요건)\s*[:：]?\s*(.*)$/i },
    { type: 'vision', re: /^(Career\s*Vision|커리어\s*비전|직무\s*비전|성장\s*비전)\s*[:：]?\s*(.*)$/i }
  ];

  function parseGenericText(text) {
    const buf = { summary: [], role: [], subject: [], req: [], plus: [], vision: [] };
    let state = 'role';
    for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
      const mk = GENERIC_MARKERS.find(m => m.re.test(line));
      if (mk) {
        state = mk.type;
        const rest = line.match(mk.re);
        const tail = rest[rest.length - 1];
        if (tail) buf[state].push(tail);
        continue;
      }
      buf[state].push(line);
    }
    const job = newJob({ summary: clean(buf.summary.join(' ')) });
    let cur = null;
    for (const t of buf.role) {
      if (/^[-•▪·]/.test(t)) {
        if (!cur) job.roles.push(cur = { title: '', items: [] });
        cur.items.push(clean(t.replace(/^[-•▪·]\s*/, '')));
      } else job.roles.push(cur = { title: clean(t.replace(/^[●■]\s*/, '')), items: [] });
    }
    let label = null;
    for (const t of buf.subject) {
      if (SUBJECT_LABEL.test(t)) { label = normMajorLabel(t); job.subjectsByMajor[label] = ''; }
      else if (label) job.subjectsByMajor[label] = clean(job.subjectsByMajor[label] + ' ' + t);
      else job.subjectsByMajor['공통'] = clean((job.subjectsByMajor['공통'] || '') + ' ' + t);
    }
    job.requirements = linesToBullets(buf.req);
    job.pluses = linesToBullets(buf.plus);
    job.careerVision = linesToBullets(buf.vision);
    return job;
  }

  function parseGeneric(pages, companyName) {
    const all = pages.map(pageText).join('\n');
    const job = parseGenericText(all);
    job.id = 'gen-0';
    job.company = companyName;
    job.job = '전체 공고 내용';
    job.title = `전체 문서 (1~${pages.length}쪽)`;
    job.pages = pages.map(p => p.pageNum);
    return [finalizeJob(job)];
  }

  // ---------------------------------------------------------------------------
  // 7. 진입점
  // ---------------------------------------------------------------------------
  function parsePages(pages) {
    const totalChars = pages.reduce((n, p) => n + p.items.reduce((m, i) => m + i.str.trim().length, 0), 0);
    if (totalChars < 30) {
      return { company: { id: 'scan', name: '' }, jobs: [], isScanned: true };
    }
    const company = detectCompany(pages);
    let jobs = [];
    if (company.id === 'samsung') jobs = parseSamsung(pages, company.name);
    else if (company.id === 'dn') jobs = parseDN(pages, company.name);

    // 전용 프로필이 없거나 결과가 없으면 레이아웃을 보고 한 번 더 시도
    if (!jobs.length) jobs = parseSamsung(pages, company.name);
    if (!jobs.length) jobs = parseDN(pages, company.name);
    if (!jobs.length) jobs = parseGeneric(pages, company.name);

    const profile = jobs[0] && jobs[0].id.split('-')[0];
    return { company, jobs, profile, isScanned: false };
  }

  // ---------------------------------------------------------------------------
  // 8. 전공 매칭 / 학년별 활용 헬퍼
  // ---------------------------------------------------------------------------
  const MAJOR_MAP = [
    { key: '기계', words: ['기계', '메카트로닉스', '자동차', '항공', '조선', '생산'] },
    { key: '전기전자(HW)', words: ['전기', '전자', '반도체', '제어', '정보통신', '통신'] },
    { key: '재료/금속', words: ['재료', '신소재', '금속', '세라믹'] },
    { key: '화학/화공', words: ['화학', '화공', '고분자', '생명화학'] },
    { key: '전산/컴퓨터', words: ['컴퓨터', '소프트웨어', '전산', '정보', 'AI', '인공지능', '데이터'] },
    { key: '산업공학', words: ['산업'] },
    { key: '수학/통계', words: ['수학', '통계'] },
    { key: '물리', words: ['물리'] },
    { key: '환경', words: ['환경'] },
    { key: '안전보건', words: ['안전', '보건', '소방'] }
  ];

  // 모집표/유관전공 문구에서 쓰이는 표현
  const ELIGIBLE_ALIASES = {
    '기계': ['기계', '메카트로닉스'],
    '전기전자(HW)': ['전기전자', '전기', '전자', '제어'],
    '재료/금속': ['재료', '금속'],
    '화학/화공': ['화학', '화공'],
    '전산/컴퓨터': ['전산', '컴퓨터', '소프트웨어'],
    '산업공학': ['산공', '산업'],
    '수학/통계': ['수학', '통계'],
    '물리': ['물리'],
    '환경': ['환경'],
    '안전보건': ['안전']
  };

  function majorCategory(myMajor) {
    const m = (myMajor || '').trim();
    if (!m) return null;
    const hit = MAJOR_MAP.find(c => c.words.some(w => m.includes(w)));
    return hit ? hit.key : null;
  }

  function pickMySubjects(job, myMajor) {
    if (!job || !job.subjectsByMajor) return null;
    const cat = majorCategory(myMajor);
    const keys = Object.keys(job.subjectsByMajor);
    if (!keys.length) return null;
    const key = keys.find(k => normMajorLabel(k) === cat) || (keys.includes('공통') ? '공통' : null);
    return key ? { key, text: job.subjectsByMajor[key], all: job.subjectsByMajor } : { key: null, text: '', all: job.subjectsByMajor };
  }

  /**
   * 모집전공 적합성 확인
   * @returns {{status: 'ok'|'warn'|'unknown', message: string}}
   */
  function checkEligibility(job, myMajor) {
    const text = (job && job.eligibleMajors) || '';
    if (!text) return { status: 'unknown', message: '' };
    if (/무관|공학\s*계열\s*전체/.test(text)) return { status: 'ok', message: `모집전공: ${text}` };
    const cat = majorCategory(myMajor);
    if (!cat) return { status: 'unknown', message: `모집전공: ${text}` };
    const aliases = ELIGIBLE_ALIASES[cat] || [cat];
    const ok = aliases.some(a => text.includes(a)) || /공학\s*계열|유관\s*공학/.test(text);
    return ok
      ? { status: 'ok', message: `내 전공(${cat})은 모집전공에 포함됩니다 · ${text}` }
      : {
        status: 'warn',
        message: `내 전공(${cat})이 모집전공에 없습니다 (${text}).` +
          (/이공기타/.test(text) ? " '이공기타'로 지원 가능한지 공고를 확인하세요." : ' 지원 자격을 다시 확인하세요.')
      };
  }

  /** 직무 데이터 → 입력칸 6개에 들어갈 문자열 */
  function toFieldTexts(job, myMajor) {
    const roleText = (job.roles || []).map(r => {
      const head = r.title ? `■ ${r.title}` : '';
      const body = r.items.map(i => `- ${i}`).join('\n');
      return [head, body].filter(Boolean).join('\n');
    }).join('\n\n');

    const qual = [];
    if (job.eligibleMajors) qual.push(`[모집전공] ${job.eligibleMajors}`);
    const nonMajorReq = (job.majorsRequired || []).filter(s => !/^전공\s*:/.test(s));
    const reqs = job.requirements && job.requirements.length ? job.requirements : nonMajorReq;
    qual.push(...reqs.map(s => `- ${s}`));
    if (job.majorsRequired && job.majorsRequired.length && job.requirements !== job.majorsRequired) {
      job.majorsRequired.filter(s => /^학위\s*:/.test(s)).forEach(s => { if (!qual.includes(`- ${s}`)) qual.push(`- ${s}`); });
    }

    const mine = pickMySubjects(job, myMajor);
    let subjects = '';
    if (mine && mine.text) subjects = `[${mine.key}] ${mine.text}`;
    else if (mine && Object.keys(mine.all).length) {
      subjects = Object.entries(mine.all).map(([k, v]) => `[${k}] ${v}`).join('\n');
    }

    return {
      summary: job.summary || '',
      jobDesc: roleText,
      qualifications: qual.join('\n'),
      preferred: (job.pluses || []).map(s => `- ${s}`).join('\n'),
      subjects,
      careerVision: (job.careerVision || []).map(s => `- ${s}`).join('\n')
    };
  }

  const api = {
    extractPdfPages, groupRows, pageText, parsePages, parseGenericText,
    detectCompany, majorCategory, pickMySubjects, checkEligibility, toFieldTexts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JDParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
