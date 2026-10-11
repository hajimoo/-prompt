/**
 * jd_parser.js 회귀 테스트 (실제 직무기술서 PDF 사용)
 *
 * 사용법:
 *   npm i pdfjs-dist@3.11.174
 *   node test_jd_parser.js "삼성전자_DS부문_26하_공채_직무기술서.pdf" "dn솔루션즈_job_profile.pdf"
 *
 * 새 회사(SK하이닉스 등) 프로필을 추가할 때도 이 파일에 기대값을 추가해 두면
 * 기존 삼성/DN 파싱이 깨지지 않았는지 바로 확인할 수 있습니다.
 */
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const JD = require('./jd_parser.js');

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

async function parse(path) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path)) }).promise;
  return JD.parsePages(await JD.extractPdfPages(doc));
}

async function testSamsung(path) {
  console.log(`\n=== 삼성전자 DS부문: ${path}`);
  const r = await parse(path);
  check('회사 감지', r.company.id === 'samsung', r.company.name);
  check('직무 11개', r.jobs.length === 11, `${r.jobs.length}개`);

  const mem = r.jobs.find(j => j.title === '메모리사업부 > 반도체공정기술');
  check('메모리 > 반도체공정기술 존재', !!mem);
  if (mem) {
    check('Role 소제목 5개 (페이지 넘어가는 블록 포함)', mem.roles.length === 5, mem.roles.map(r => r.title).join(' / '));
    check('Role에 검사·계측 블록 포함', mem.roles.some(r => /Inspection/.test(r.title)));
    check('추천과목에 업무 내용이 섞이지 않음', !/설비 문제/.test(Object.values(mem.subjectsByMajor).join(' ')));
    check('기계 추천과목', /메카트로닉스/.test(mem.subjectsByMajor['기계'] || ''), mem.subjectsByMajor['기계']);
    check('교대근무 요건 추출', mem.requirements.some(s => /교대근무/.test(s)));
    check('근무지', /천안/.test(mem.location), mem.location);
    check('모집전공(2쪽 표)', /기계/.test(mem.eligibleMajors), mem.eligibleMajors);
  }

  const design = r.jobs.find(j => j.title === '메모리사업부 > 반도체공정설계');
  check('반도체공정설계 Role 4블록 모두 복원', design && design.roles.length === 4,
    design && design.roles.map(r => r.title).join(' / '));

  const same = r.jobs.filter(j => j.job === '반도체공정기술').map(j => j.division);
  check('동명 직무 3개 사업부', same.length === 3, same.join(', '));

  const slsi = r.jobs.find(j => j.division === 'S.LSI사업부');
  check('기계공학과 → S.LSI 회로설계 경고', JD.checkEligibility(slsi, '기계공학과').status === 'warn');
  check('신소재공학과 → 재료/금속 추천과목',
    /재료공학개론/.test(JD.pickMySubjects(mem, '신소재공학과').text));
}

async function testDN(path) {
  console.log(`\n=== DN솔루션즈: ${path}`);
  const r = await parse(path);
  check('회사 감지', r.company.id === 'dn', r.company.name);
  check('직무 20개', r.jobs.length === 20, `${r.jobs.length}개`);

  const mech = r.jobs.find(j => j.job === '기계(기계설계)');
  check('기계설계 존재', !!mech);
  if (mech) {
    check('Role 소제목 2개', mech.roles.length === 2, mech.roles.map(r => r.title).join(' / '));
    check('우대사항 4개', mech.pluses.length === 4, mech.pluses.join(' | '));
    check('Career Vision 4줄', mech.careerVision.length === 4);
    check('유관전공', /메카트로닉스/.test(mech.eligibleMajors), mech.eligibleMajors);
    check('근무지', mech.location === '창원/서울', mech.location);
  }
  const servo = r.jobs.find(j => /선행제어\[3\]/.test(j.job));
  check('선행제어[3] Role 4블록 (블록 간격이 섹션 간격보다 큰 페이지)', servo && servo.roles.length === 4,
    servo && servo.roles.map(r => r.title).join(' / '));
  const ae = r.jobs.find(j => /AE\[1\]/.test(j.job));
  check('AE[1] Role 4블록', ae && ae.roles.length === 4);
  check('본문 "및"이 지워지지 않음', /공작기계 및 로봇/.test(ae ? ae.summary : ''), ae && ae.summary.slice(0, 30));
  const fin = r.jobs.find(j => /재무/.test(j.job));
  check('기계공학과 → 재무 경고', JD.checkEligibility(fin, '기계공학과').status === 'warn');
}

(async () => {
  const [ss, dn] = process.argv.slice(2);
  if (!ss && !dn) {
    console.log('사용법: node test_jd_parser.js <삼성 PDF> [DN PDF]');
    process.exit(1);
  }
  if (ss) await testSamsung(ss);
  if (dn) await testDN(dn);
  console.log(failed ? `\n❌ 실패 ${failed}건` : '\n✅ 전체 통과');
  process.exit(failed ? 1 : 0);
})();
