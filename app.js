/**
 * 메인 애플리케이션 로직
 * - PDF, DOCX, PPTX(히든), TXT 문서 파싱 지원 (HWP 제외)
 * - 단 1회 정확한 Gemini API 추출 및 실시간 진단 기능
 */

/**
 * PDF, Word(docx), PPTX(히든 지원), TXT 파일에서 글자 깨짐 없이 정밀 추출하는 함수
 */
async function parseDocumentFile(file) {
  const fileName = file.name.toLowerCase();

  // HWP/HWPX 파일 명시적 차단
  if (fileName.endsWith('.hwp') || fileName.endsWith('.hwpx')) {
    throw new Error('HWP(한글) 파일은 지원하지 않습니다. TXT, Word(.docx), PDF 파일로 변환 후 업로드해주세요.');
  }

  // 1. 일반 텍스트 파일 (.txt, .md)
  if (fileName.endsWith('.txt') || fileName.endsWith('.md')) {
    return await file.text();
  }

  // 2. PDF 파일 (.pdf) -> PDF.js 활용
  if (fileName.endsWith('.pdf')) {
    if (!window.pdfjsLib) {
      throw new Error('PDF 엔진이 로드되지 않았습니다. 인터넷 연결을 확인해 주세요.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageItems = textContent.items.map(item => item.str).join(' ');
      fullText += pageItems + '\n';
    }

    const clean = fullText.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 5) {
      throw new Error('PDF 텍스트를 파싱할 수 없습니다. 스캔된 이미지 PDF일 수 있습니다.');
    }
    return clean;
  }

  // 3. Word 파일 (.docx) -> Mammoth.js 활용
  if (fileName.endsWith('.docx')) {
    if (!window.mammoth) {
      throw new Error('Word 변환 엔진이 로드되지 않았습니다.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
    const clean = (result.value || '').replace(/\s+/g, ' ').trim();
    if (!clean) {
      throw new Error('Word 문서에서 텍스트를 읽을 수 없습니다.');
    }
    return clean;
  }

  // 4. PPTX 파일 (.pptx) -> 히든 업로드 지원
  if (fileName.endsWith('.pptx')) {
    if (!window.JSZip) {
      throw new Error('PPTX 압축 해제 엔진이 로드되지 않았습니다.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    let slideTexts = [];

    const slideFiles = Object.keys(zip.files).filter(filename =>
      filename.startsWith('ppt/slides/slide') && filename.endsWith('.xml')
    );

    // 슬라이드 번호 순으로 정렬
    slideFiles.sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    });

    for (const slidePath of slideFiles) {
      const xmlText = await zip.files[slidePath].async('string');
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      const textNodes = xmlDoc.getElementsByTagName('a:t');
      let currentSlideText = '';
      for (let i = 0; i < textNodes.length; i++) {
        currentSlideText += textNodes[i].textContent + ' ';
      }
      if (currentSlideText.trim()) {
        slideTexts.push(currentSlideText.trim());
      }
    }

    const clean = slideTexts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
    if (!clean) {
      throw new Error('PPTX 슬라이드에서 텍스트를 읽을 수 없습니다.');
    }
    return clean;
  }

  throw new Error('지원하지 않는 파일 형식입니다. (지원: TXT, Word, PDF)');
}

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements - 설정 및 연결
  const apiKeyInput = document.getElementById('apiKeyInput');
  const btnToggleKey = document.getElementById('btnToggleKey');
  const btnSaveKey = document.getElementById('btnSaveKey');
  const btnDeleteKey = document.getElementById('btnDeleteKey');
  const btnTestKey = document.getElementById('btnTestKey');
  const modelSelect = document.getElementById('modelSelect');
  const apiStatusBadge = document.getElementById('apiStatusBadge');
  const apiKeySaveStatus = document.getElementById('apiKeySaveStatus');
  const btnToggleGuide = document.getElementById('btnToggleGuide');
  const btnCloseGuide = document.getElementById('btnCloseGuide');
  const apiGuideContainer = document.getElementById('apiGuideContainer');

  // DOM Elements - 진단 카드
  const diagnosticCard = document.getElementById('diagnosticCard');
  const diagTitle = document.getElementById('diagTitle');
  const diagModel = document.getElementById('diagModel');
  const diagStatus = document.getElementById('diagStatus');
  const diagMessage = document.getElementById('diagMessage');
  const diagGuide = document.getElementById('diagGuide');
  const btnCopyDiag = document.getElementById('btnCopyDiag');

  // Form Inputs
  const companyInput = document.getElementById('company');
  const jobInput = document.getElementById('job');
  const orgInput = document.getElementById('org');
  const jobUrlInput = document.getElementById('jobUrl');
  const gradeSelect = document.getElementById('grade');
  const majorInput = document.getElementById('major');
  const experienceInput = document.getElementById('experience');
  const essayQuestionsInput = document.getElementById('essayQuestions');

  // 내 정보 (전공·경험) 저장 및 파일 업로드 Elements
  const btnSaveMyInfo = document.getElementById('btnSaveMyInfo');
  const btnDeleteMyInfo = document.getElementById('btnDeleteMyInfo');
  const myInfoStatus = document.getElementById('myInfoStatus');
  const btnUploadExp = document.getElementById('btnUploadExp');
  const expFileInput = document.getElementById('expFileInput');

  // Extraction Inputs
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const previewList = document.getElementById('previewList');
  const btnExtract = document.getElementById('btnExtract');
  const btnExtractText = document.getElementById('btnExtractText');
  const btnExtractIcon = document.getElementById('btnExtractIcon');
  const jobDescInput = document.getElementById('jobDesc');
  const qualificationsInput = document.getElementById('qualifications');
  const preferredInput = document.getElementById('preferred');
  const jobSummaryInput = document.getElementById('jobSummary');
  const subjectsInput = document.getElementById('subjects');
  const subjectsHint = document.getElementById('subjectsHint');
  const careerVisionInput = document.getElementById('careerVision');
  const locationInput = document.getElementById('location');

  // PDF 직무 선택기 Elements
  const pdfJobSelectorCard = document.getElementById('pdfJobSelectorCard');
  const pdfJobCountBadge = document.getElementById('pdfJobCountBadge');
  const pdfJobSearchInput = document.getElementById('pdfJobSearchInput');
  const pdfJobChipList = document.getElementById('pdfJobChipList');
  const pdfDivisionFilter = document.getElementById('pdfDivisionFilter');
  const jdSelectedInfo = document.getElementById('jdSelectedInfo');
  const jdSelectedTitle = document.getElementById('jdSelectedTitle');
  const jdSelectedMeta = document.getElementById('jdSelectedMeta');
  const jdEligibility = document.getElementById('jdEligibility');

  // Prompt Output
  const validationBadge = document.getElementById('validationBadge');
  const placeholderCountBadge = document.getElementById('placeholderCountBadge');
  const promptPreview = document.getElementById('promptPreview');
  const btnGoChatGPT = document.getElementById('btnGoChatGPT');
  const btnGoGemini = document.getElementById('btnGoGemini');
  const btnGoClaude = document.getElementById('btnGoClaude');
  const btnCopy = document.getElementById('btnCopy');
  const toast = document.getElementById('toast');

  // State
  let uploadedFiles = [];
  let detectedPdfJobs = [];
  let selectedPdfJob = null;
  let detectedCompanyGlobal = '';
  let selectedDivision = '';          // 사업부 필터 ('' = 전체)
  let ambiguousJobIds = [];           // 이름이 같은 직무 후보 (예: 반도체공정기술 × 3개 사업부)
  let scannedPdfFile = null;          // 텍스트가 없는 스캔 PDF (Gemini 대상)
  let lastParsedPdf = null;           // 같은 파일 재파싱 방지

  // 1. API Key 및 지정 모델 관리 & 상태 배지 관리
  function setApiStatus(state, label) {
    if (!apiStatusBadge) return;
    apiStatusBadge.className = `api-status-badge status-${state}`;
    apiStatusBadge.textContent = label;
  }

  function updateKeySaveStatus() {
    if (!apiKeySaveStatus) return;
    const saved = localStorage.getItem('gemini_api_key');
    const current = apiKeyInput ? apiKeyInput.value.trim() : '';
    if (saved && saved === current) {
      apiKeySaveStatus.className = 'api-save-status saved';
      apiKeySaveStatus.textContent = '현재 브라우저에 저장됨';
    } else if (current && saved !== current) {
      apiKeySaveStatus.className = 'api-save-status';
      apiKeySaveStatus.textContent = '미저장 (수정됨)';
    } else {
      apiKeySaveStatus.className = 'api-save-status';
      apiKeySaveStatus.textContent = '미저장';
    }
  }

  // 초기 상태 설정
  const savedKey = localStorage.getItem('gemini_api_key') || '';
  if (savedKey) {
    apiKeyInput.value = savedKey;
  }
  updateKeySaveStatus();
  setApiStatus('unverified', '미확인');

  let savedModel = localStorage.getItem('gemini_model') || 'gemini-3.6-flash';
  if (savedModel === 'gemini-2.0-flash' || savedModel === 'gemini-1.5-flash' || savedModel === 'auto') {
    savedModel = 'gemini-3.6-flash';
    localStorage.setItem('gemini_model', savedModel);
  }

  if (modelSelect) {
    modelSelect.value = savedModel;
    modelSelect.addEventListener('change', () => {
      localStorage.setItem('gemini_model', modelSelect.value);
      setApiStatus('unverified', '미확인');
      hideDiagnostic();
    });
  }

  // 키 입력 시 상태 초기화
  apiKeyInput.addEventListener('input', () => {
    setApiStatus('unverified', '미확인');
    updateKeySaveStatus();
    hideDiagnostic();
  });

  // 처음 사용자를 위한 접이식 안내 토글
  let isGuideOpen = false;
  function toggleGuide(forceState) {
    isGuideOpen = typeof forceState === 'boolean' ? forceState : !isGuideOpen;
    if (apiGuideContainer) {
      apiGuideContainer.style.display = isGuideOpen ? 'block' : 'none';
      if (isGuideOpen) {
        apiGuideContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    if (btnToggleGuide) {
      btnToggleGuide.textContent = isGuideOpen ? '❓ 처음 사용하나요? [안내 닫기 ▴]' : '❓ 처음 사용하나요? [안내 열기 ▾]';
    }
  }

  if (btnToggleGuide) {
    btnToggleGuide.addEventListener('click', () => toggleGuide());
  }
  if (btnCloseGuide) {
    btnCloseGuide.addEventListener('click', () => toggleGuide(false));
  }

  btnToggleKey.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      btnToggleKey.textContent = '숨김';
    } else {
      apiKeyInput.type = 'password';
      btnToggleKey.textContent = '보기';
    }
  });

  btnSaveKey.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
      localStorage.setItem('gemini_api_key', key);
      updateKeySaveStatus();
      showToast('API Key가 현재 브라우저에 안전하게 저장되었습니다.', 'success');
    } else {
      localStorage.removeItem('gemini_api_key');
      updateKeySaveStatus();
      showToast('API Key가 제거되었습니다.', 'info');
    }
  });

  if (btnDeleteKey) {
    btnDeleteKey.addEventListener('click', () => {
      localStorage.removeItem('gemini_api_key');
      apiKeyInput.value = '';
      updateKeySaveStatus();
      setApiStatus('unverified', '미확인');
      hideDiagnostic();
      showToast('저장된 API Key가 안전하게 삭제되었습니다.', 'info');
    });
  }

  // 1-2. 내 정보 (전공·경험) 브라우저(localStorage) 저장 및 파일 업로드 관리
  function updateMyInfoStatus() {
    const savedMajor = localStorage.getItem('my_major');
    const savedExp = localStorage.getItem('my_experience');

    if (savedMajor !== null || savedExp !== null) {
      if (myInfoStatus) {
        myInfoStatus.className = 'my-info-status';
        const expPreview = (savedExp && savedExp.trim().length > 0) ? `경험 ${savedExp.trim().length}자` : '경험 비어있음';
        myInfoStatus.textContent = `💾 브라우저 저장됨 (${savedMajor || '전공 미지정'} / ${expPreview})`;
      }
    } else {
      if (myInfoStatus) {
        myInfoStatus.className = 'my-info-status empty';
        myInfoStatus.textContent = 'ℹ️ 저장된 내 정보 없음';
      }
    }
  }

  function loadMyInfo() {
    const savedMajor = localStorage.getItem('my_major');
    const savedExp = localStorage.getItem('my_experience');

    if (savedMajor !== null) {
      majorInput.value = savedMajor;
    } else {
      majorInput.value = '기계공학과';
    }

    if (savedExp !== null) {
      experienceInput.value = savedExp;
    } else {
      experienceInput.value = '';
    }

    updateMyInfoStatus();
  }

  if (btnSaveMyInfo) {
    btnSaveMyInfo.addEventListener('click', () => {
      const majorVal = majorInput.value.trim() || '기계공학과';
      const expVal = experienceInput.value;

      localStorage.setItem('my_major', majorVal);
      localStorage.setItem('my_experience', expVal);

      updateMyInfoStatus();
      updatePrompt();
      showToast('전공과 경험이 현재 브라우저에 저장되었습니다.', 'success');
    });
  }

  if (btnDeleteMyInfo) {
    btnDeleteMyInfo.addEventListener('click', () => {
      localStorage.removeItem('my_major');
      localStorage.removeItem('my_experience');

      majorInput.value = '기계공학과';
      experienceInput.value = '';

      updateMyInfoStatus();
      updatePrompt();
      showToast('저장된 내 정보(전공, 경험)가 브라우저에서 삭제되었습니다.', 'info');
    });
  }

  // 경험칸 문서 파일 업로드 (PDF, Word, TXT, 히든 PPTX 지원 / HWP 명시적 차단)
  if (btnUploadExp && expFileInput) {
    btnUploadExp.addEventListener('click', () => {
      expFileInput.click();
    });

    expFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const fileName = file.name.toLowerCase();
      if (fileName.endsWith('.hwp') || fileName.endsWith('.hwpx')) {
        showToast('❌ HWP(한글) 파일은 지원하지 않습니다. TXT, Word, PDF 파일로 변환 후 업로드해주세요.', 'error');
        expFileInput.value = '';
        return;
      }

      showToast(`⏳ 파일('${file.name}') 분석 및 텍스트 추출 중...`, 'info');

      try {
        const extractedText = await parseDocumentFile(file);
        experienceInput.value = extractedText;
        updatePrompt();
        showToast(`✅ '${file.name}'의 텍스트 내용(${extractedText.length}자)을 불러왔습니다. 계속 보관하려면 [내 정보 저장]을 누르세요.`, 'success');
      } catch (err) {
        console.error('문서 읽기 오류:', err);
        showToast(`오류: ${err.message || '파일을 읽는 도중 문제가 발생했습니다.'}`, 'error');
      } finally {
        expFileInput.value = '';
      }
    });
  }

  // 2. 단 1회 가벼운 연결 테스트 (0.5초 진단)
  btnTestKey.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showToast('API Key를 먼저 입력해주세요.', 'error');
      apiKeyInput.focus();
      return;
    }

    const selectedModel = modelSelect ? modelSelect.value : 'gemini-3.6-flash';
    btnTestKey.disabled = true;
    btnTestKey.textContent = '⏳ 테스트 중...';
    setApiStatus('checking', '확인 중...');
    hideDiagnostic();

    try {
      await testGeminiConnection(key, selectedModel);
      setApiStatus('success', '연결 성공');
      showToast(`✅ [${selectedModel}] 단순 텍스트 연결 테스트 성공! (API 키 및 모델 정상)`, 'success');
    } catch (err) {
      console.error('연결 테스트 에러:', err);
      setApiStatus('error', '연결 실패');
      showDiagnostic({
        title: '⚠️ [연결 테스트] 호출 실패',
        model: err.model || selectedModel,
        status: err.status || '통신 실패',
        statusText: err.statusText || '',
        message: err.apiMessage || err.message
      });
      showToast('연결 테스트 실패: 아래 진단창의 오류 문구를 확인하세요.', 'error');
    } finally {
      btnTestKey.disabled = false;
      btnTestKey.textContent = '⚡ 연결 테스트';
    }
  });

  // 3. 진단 카드 표시 및 복사 로직
  function showDiagnostic({ title, model, status, statusText, message }) {
    if (!diagnosticCard) return;
    diagTitle.textContent = title || '⚠️ API 호출 오류 진단 정보';
    diagModel.textContent = model || '-';
    diagStatus.textContent = status ? `${status} (${statusText || 'Error'})` : '네트워크 / 인증 실패';
    diagMessage.textContent = message || '알 수 없는 오류가 발생했습니다.';

    let guideHtml = '';
    const msgStr = (message || '').toLowerCase();
    const stCode = Number(status);

    if (stCode === 400 && (msgStr.includes('api_key_invalid') || msgStr.includes('api key not valid'))) {
      guideHtml = '🔑 <strong>API 키 오류 (400)</strong>: Google AI Studio에서 발급받은 키와 일치하지 않습니다. 복사 시 앞뒤 공백이 들어갔거나 오탈자가 있는지 확인하고 무료 키를 재발급받아보세요.';
    } else if (stCode === 400 && msgStr.includes('mime_type')) {
      guideHtml = '🖼️ <strong>이미지 형식 오류 (400)</strong>: 이미지 파일의 MIME 타입이 올바르지 않습니다. 일반 PNG 또는 JPG 캡처 이미지를 올려주세요.';
    } else if (stCode === 404 || msgStr.includes('not found') || msgStr.includes('no longer available')) {
      guideHtml = '❌ <strong>구버전 모델 만료 (404)</strong>: 해당 모델이 만료되었습니다. 상단 [지정 모델] 드롭다운에서 <strong>3.6 Flash</strong> 또는 <strong>3.5 Flash-Lite</strong>로 선택 후 다시 시도해보세요.';
    } else if (stCode === 429) {
      guideHtml = '⏱️ <strong>무료 요청 한도(15 RPM) 일시 초과 (429)</strong>: 무료 티어의 1분당 최대 요청 횟수에 도달했습니다. 1~2분 정도 기다린 후 다시 눌러주세요.';
    } else if (stCode === 403) {
      guideHtml = '🚫 <strong>권한 오류 (403)</strong>: API 키 사용 권한이 비활성화되었거나 해당 국가에서 제한되었습니다. Google AI Studio 콘솔을 확인해주세요.';
    } else {
      guideHtml = '💡 <strong>조치 제안</strong>: 상단 <strong>[지정 모델]</strong>을 <code>gemini-3.6-flash</code>로 선택하고, <strong>[⚡ 연결 테스트]</strong>를 눌러 정상 작동 여부를 확인해보세요.';
    }

    diagGuide.innerHTML = guideHtml;
    diagnosticCard.style.display = 'block';
  }

  function hideDiagnostic() {
    if (diagnosticCard) {
      diagnosticCard.style.display = 'none';
    }
  }

  btnCopyDiag.addEventListener('click', () => {
    const text = `[Gemini API 진단 정보]\n- 모델명: ${diagModel.textContent}\n- 상태 코드: ${diagStatus.textContent}\n- 오류 문구: ${diagMessage.textContent}\n- 진단 가이드: ${diagGuide.textContent.replace(/<[^>]*>/g, '')}`;
    navigator.clipboard.writeText(text).then(() => {
      showToast('진단 정보가 클립보드에 복사되었습니다. 바로 공유할 수 있습니다.', 'success');
    });
  });

  // 4. 파일 업로드 및 드래그앤드롭 관리
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
      fileInput.value = '';
    }
  });

  window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    const pastedImageFiles = [];
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) pastedImageFiles.push(file);
      }
    }
    if (pastedImageFiles.length > 0) {
      addFiles(pastedImageFiles);
      showToast(`클립보드에서 이미지 ${pastedImageFiles.length}장을 가져왔습니다.`, 'success');
    }
  });

  // --- 직무기술서(PDF) 자동 스캔 및 직무별 발췌 (jd_parser.js) ---

  const isPdfFile = f => f.type === 'application/pdf' || (f.name || '').toLowerCase().endsWith('.pdf');

  async function loadPdf(file) {
    if (!window.pdfjsLib) throw new Error('PDF 엔진이 로드되지 않았습니다. 인터넷 연결을 확인해 주세요.');
    const arrayBuffer = await file.arrayBuffer();
    return pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderDivisionFilter() {
    if (!pdfDivisionFilter) return;
    pdfDivisionFilter.innerHTML = '';
    const divisions = Array.from(new Set(detectedPdfJobs.map(j => j.division).filter(Boolean)));
    if (divisions.length < 2) return;
    ['', ...divisions].forEach(d => {
      const count = d ? detectedPdfJobs.filter(j => j.division === d).length : detectedPdfJobs.length;
      const b = el('button', `pdf-division-chip ${selectedDivision === d ? 'active' : ''}`, `${d || '전체'} ${count}`);
      b.type = 'button';
      b.addEventListener('click', () => {
        selectedDivision = d;
        renderDivisionFilter();
        renderPdfJobChips(detectedPdfJobs, pdfJobSearchInput ? pdfJobSearchInput.value : '');
      });
      pdfDivisionFilter.appendChild(b);
    });
  }

  function renderPdfJobChips(jobs, filterKeyword = '') {
    if (!pdfJobChipList) return;
    const kws = filterKeyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = jobs.filter(j => {
      if (selectedDivision && j.division !== selectedDivision) return false;
      const hay = `${j.title} ${j.dept} ${j.location}`.toLowerCase();
      return kws.every(k => hay.includes(k));   // "메모리 공정기술" 처럼 여러 단어 검색 지원
    });

    if (pdfJobCountBadge) pdfJobCountBadge.textContent = `${filtered.length}개 직무`;

    pdfJobChipList.innerHTML = '';
    if (filtered.length === 0) {
      pdfJobChipList.appendChild(el('span', 'hint-text', '검색어와 일치하는 직무가 없습니다.'));
      return;
    }

    filtered.forEach(job => {
      const active = selectedPdfJob && selectedPdfJob.id === job.id;
      const btn = el('button', `pdf-job-chip ${active ? 'active' : ''} ${ambiguousJobIds.includes(job.id) ? 'ambiguous' : ''}`);
      btn.type = 'button';
      btn.title = job.location ? `근무지: ${job.location}` : '';
      btn.appendChild(el('span', 'chip-title', job.title));
      btn.appendChild(el('span', 'chip-pages', job.pageRange));
      btn.addEventListener('click', () => selectPdfJob(job));
      pdfJobChipList.appendChild(btn);
    });
  }

  function refreshEligibility() {
    if (!jdSelectedInfo) return;
    if (!selectedPdfJob) { jdSelectedInfo.style.display = 'none'; return; }
    const job = selectedPdfJob;
    jdSelectedInfo.style.display = 'block';
    jdSelectedTitle.textContent = `🎯 ${job.company ? job.company + ' · ' : ''}${job.title}`;
    const meta = [job.pageRange, job.location && `근무지 ${job.location}`, job.dept && `부서 ${job.dept}`].filter(Boolean);
    jdSelectedMeta.textContent = meta.join(' · ');
    const elig = JDParser.checkEligibility(job, majorInput.value);
    jdEligibility.className = `jd-eligibility ${elig.status}`;
    jdEligibility.textContent = elig.message ? (elig.status === 'warn' ? '⚠️ ' : elig.status === 'ok' ? '✅ ' : 'ℹ️ ') + elig.message : '';
  }

  /** 전공이 바뀌면 추천과목 칸을 내 전공 줄로 다시 채움 */
  function refreshSubjectsForMajor() {
    if (!selectedPdfJob) return;
    const fields = JDParser.toFieldTexts(selectedPdfJob, majorInput.value);
    subjectsInput.value = fields.subjects;
    const mine = JDParser.pickMySubjects(selectedPdfJob, majorInput.value);
    if (subjectsHint) {
      const keys = Object.keys(selectedPdfJob.subjectsByMajor || {});
      subjectsHint.textContent = !keys.length ? '이 직무기술서에는 추천과목이 없습니다'
        : (mine && mine.text) ? `내 전공 → [${mine.key}] 줄 자동 선택`
        : `내 전공과 일치하는 줄이 없어 전체(${keys.length}개 전공) 표시`;
    }
  }

  function selectPdfJob(job) {
    selectedPdfJob = job;
    ambiguousJobIds = [];
    renderPdfJobChips(detectedPdfJobs, pdfJobSearchInput ? pdfJobSearchInput.value : '');

    // 1. ①번 기본 정보 자동 채우기
    const company = job.company || detectedCompanyGlobal;
    if (company) companyInput.value = company;
    if (job.job && job.job !== '전체 공고 내용') jobInput.value = job.job;
    orgInput.value = [job.division, job.dept && job.dept !== job.job ? job.dept : ''].filter(Boolean).join(' / ');
    if (job.location) {
      const shift = (job.requirements || []).some(r => /교대근무/.test(r)) ? ' / 교대근무(변형교대) 가능자' : '';
      locationInput.value = job.location + shift;
    }

    // 2. 구조화된 텍스트 즉시 발췌 (API 호출 없음)
    const f = JDParser.toFieldTexts(job, majorInput.value);
    jobSummaryInput.value = f.summary;
    jobDescInput.value = f.jobDesc;
    qualificationsInput.value = f.qualifications;
    preferredInput.value = f.preferred;
    careerVisionInput.value = f.careerVision;
    refreshSubjectsForMajor();
    refreshEligibility();

    updatePrompt();
    showToast(`🎯 [${job.title}] (${job.pageRange}) 내용을 발췌했습니다. API 호출 없이 완료!`, 'success');
  }

  function clearPdfJobs() {
    detectedPdfJobs = [];
    selectedPdfJob = null;
    selectedDivision = '';
    ambiguousJobIds = [];
    scannedPdfFile = null;
    lastParsedPdf = null;
    if (pdfJobSearchInput) pdfJobSearchInput.value = '';
    if (pdfJobSelectorCard) pdfJobSelectorCard.style.display = 'none';
    refreshEligibility();
  }

  async function checkAndScanPdfFiles() {
    const pdfFile = uploadedFiles.find(isPdfFile);
    if (!pdfFile) { clearPdfJobs(); return; }
    if (lastParsedPdf === pdfFile) return;

    try {
      showToast('⏳ 직무기술서 PDF 분석 중... (직무 목차 자동 스캔)', 'info');
      const pdf = await loadPdf(pdfFile);
      const pages = await JDParser.extractPdfPages(pdf);
      const result = JDParser.parsePages(pages);
      lastParsedPdf = pdfFile;

      if (result.isScanned) {
        detectedPdfJobs = [];
        selectedPdfJob = null;
        scannedPdfFile = pdfFile;
        if (pdfJobSelectorCard) pdfJobSelectorCard.style.display = 'none';
        showToast('📷 텍스트가 없는 스캔 PDF입니다. [이미지·스캔 PDF 텍스트 추출하기]로 Gemini 추출을 진행하세요.', 'info');
        return;
      }

      scannedPdfFile = null;
      detectedPdfJobs = result.jobs;
      detectedCompanyGlobal = result.company.name || '';
      selectedDivision = '';
      selectedPdfJob = null;
      ambiguousJobIds = [];
      if (pdfJobSearchInput) pdfJobSearchInput.value = '';   // 이전 PDF의 검색어가 새 목록을 가리지 않도록
      if (detectedCompanyGlobal) companyInput.value = detectedCompanyGlobal;

      if (pdfJobSelectorCard) pdfJobSelectorCard.style.display = 'block';
      renderDivisionFilter();

      // 입력칸에 이미 직무명이 적혀있다면 자동 매칭 (같은 이름이 여러 사업부에 있으면 사용자에게 선택 요청)
      const currentJob = jobInput.value.trim().toLowerCase();
      const currentOrg = orgInput.value.trim().toLowerCase();
      let message = `📄 ${detectedCompanyGlobal || '직무기술서'}에서 ${result.jobs.length}개의 직무를 감지했습니다. 분석할 직무를 선택하세요.`;
      if (currentJob) {
        let matched = result.jobs.filter(j => j.job.toLowerCase().includes(currentJob) || j.title.toLowerCase().includes(currentJob));
        if (matched.length > 1 && currentOrg) {
          const byOrg = matched.filter(j => j.division.toLowerCase().includes(currentOrg) || currentOrg.includes(j.division.toLowerCase()));
          if (byOrg.length) matched = byOrg;
        }
        if (matched.length === 1) {
          renderPdfJobChips(detectedPdfJobs, pdfJobSearchInput ? pdfJobSearchInput.value : '');
          selectPdfJob(matched[0]);
          return;
        }
        if (matched.length > 1) {
          ambiguousJobIds = matched.map(j => j.id);
          message = `🔎 '${jobInput.value.trim()}' 직무가 ${matched.length}개 사업부에 있습니다 (${matched.map(j => j.division).join(', ')}). 원하는 사업부의 직무를 선택하세요.`;
        }
      }
      renderPdfJobChips(detectedPdfJobs, pdfJobSearchInput ? pdfJobSearchInput.value : '');
      showToast(message, 'success');
    } catch (err) {
      console.error('PDF 스캔 오류:', err);
      showToast(`PDF 분석 오류: ${err.message}`, 'error');
    }
  }

  if (pdfJobSearchInput) {
    pdfJobSearchInput.addEventListener('input', () => {
      renderPdfJobChips(detectedPdfJobs, pdfJobSearchInput.value);
    });
  }

  majorInput.addEventListener('input', () => {
    refreshSubjectsForMajor();
    refreshEligibility();
  });

  async function addFiles(files) {
    const junior = isJuniorMode();
    const validFiles = files.filter(f =>
      f.type.startsWith('image/') ||
      (junior && isPdfFile(f)) ||
      (f.name || '').match(junior ? /\.(png|jpg|jpeg|webp|pdf)$/i : /\.(png|jpg|jpeg|webp)$/i)
    );
    if (validFiles.length === 0) {
      showToast(junior
        ? '이미지 파일(PNG, JPG, WEBP) 또는 직무기술서(PDF)만 등록 가능합니다.'
        : '이미지 파일(PNG, JPG, WEBP 등)만 등록 가능합니다.', 'error');
      return;
    }
    uploadedFiles = uploadedFiles.concat(validFiles);
    renderPreviews();
    updateExtractButtonState();
    await checkAndScanPdfFiles();
  }

  function removeFile(index) {
    uploadedFiles.splice(index, 1);
    renderPreviews();
    updateExtractButtonState();
    checkAndScanPdfFiles();
  }

  function renderPreviews() {
    previewList.innerHTML = '';
    uploadedFiles.forEach((file, index) => {
      const chip = document.createElement('div');
      chip.className = 'preview-chip';

      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const pdfIcon = document.createElement('div');
        pdfIcon.className = 'preview-pdf-icon';
        pdfIcon.textContent = 'PDF';
        chip.appendChild(pdfIcon);
      } else {
        const thumb = document.createElement('img');
        thumb.className = 'preview-thumb';
        thumb.src = URL.createObjectURL(file);
        chip.appendChild(thumb);
      }

      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = file.name || `첨부 파일 ${index + 1}`;

      const removeBtn = document.createElement('span');
      removeBtn.className = 'chip-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = '제거';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFile(index);
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      previewList.appendChild(chip);
    });
  }

  function updateExtractButtonState() {
    btnExtract.disabled = uploadedFiles.length === 0;
  }

  /** PDF의 지정 페이지를 PNG File로 렌더링 (Gemini에 선택 직무 페이지만 보내기 위함) */
  async function renderPdfPagesToImages(file, pageNums, maxPages = 6) {
    const pdf = await loadPdf(file);
    const nums = (pageNums && pageNums.length ? pageNums : Array.from({ length: pdf.numPages }, (_, i) => i + 1)).slice(0, maxPages);
    const out = [];
    for (const n of nums) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      out.push(new File([blob], `${file.name}-p${n}.png`, { type: 'image/png' }));
    }
    return out;
  }

  // 5. Gemini 추출 (이미지 / 스캔 PDF / 텍스트 파서가 놓친 경우에만 사용)
  btnExtract.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim() || localStorage.getItem('gemini_api_key');
    if (!apiKey) {
      showToast('상단에 Gemini API Key를 먼저 입력해주세요. (텍스트 PDF는 직무 칩 선택만으로 키 없이 발췌됩니다)', 'error');
      apiKeyInput.focus();
      return;
    }

    if (uploadedFiles.length === 0) {
      showToast('추출할 채용공고 또는 직무기술서를 먼저 등록해주세요.', 'error');
      return;
    }

    const selectedModel = modelSelect ? modelSelect.value : 'gemini-3.6-flash';
    const targetJobInfo = selectedPdfJob
      ? `${selectedPdfJob.division} - ${selectedPdfJob.job} (${selectedPdfJob.pageRange})`
      : (jobInput.value.trim() ? `${orgInput.value.trim()} - ${jobInput.value.trim()}` : '');

    btnExtract.disabled = true;
    btnExtractIcon.innerHTML = '<span class="spinner"></span>';
    btnExtractText.textContent = `[${selectedModel}] 텍스트 추출 요청 중 (단 1회)...`;
    setApiStatus('checking', '확인 중...');
    hideDiagnostic();

    try {
      // PDF는 통째로 보내지 않고, 선택한 직무 페이지(또는 스캔 PDF 앞쪽 몇 장)만 이미지로 변환해 전송
      const sendFiles = [];
      for (const f of uploadedFiles) {
        if (!isPdfFile(f)) { sendFiles.push(f); continue; }
        const pages = (selectedPdfJob && f === lastParsedPdf) ? selectedPdfJob.pages : null;
        sendFiles.push(...await renderPdfPagesToImages(f, pages));
      }

      const extracted = await extractJobPostingText(apiKey, sendFiles, selectedModel, targetJobInfo, majorInput.value);

      jobDescInput.value = extracted.job_description || '';
      preferredInput.value = extracted.preferred || '';
      if (isJuniorMode()) {
        jobSummaryInput.value = extracted.summary || jobSummaryInput.value;
        qualificationsInput.value = extracted.qualifications || '';
        subjectsInput.value = extracted.subjects || '';
        careerVisionInput.value = extracted.career_vision || '';
        if (extracted.location && !locationInput.value.trim()) locationInput.value = extracted.location;
      } else {
        qualificationsInput.value = [extracted.qualifications, extracted.subjects].filter(Boolean).join('\n');
      }
      if (extracted.company && !companyInput.value.trim()) companyInput.value = extracted.company;
      if (extracted.job && !jobInput.value.trim()) jobInput.value = extracted.job;

      updatePrompt();
      setApiStatus('success', '이미지 추출 성공');
      showToast(`✅ 텍스트가 추출되었습니다! (모델: ${extracted.usedModel}, 이미지 ${sendFiles.length}장 전송)`, 'success');
    } catch (err) {
      console.error('추출 실패 에러:', err);
      setApiStatus('error', '추출 실패');
      showDiagnostic({
        title: '⚠️️ 채용공고 텍스트 추출 실패',
        model: err.model || selectedModel,
        status: err.status || '호출 실패',
        statusText: err.statusText || '',
        message: err.apiMessage || err.message
      });
      showToast(`추출 실패: 아래 진단창의 [오류 문구]를 확인해주세요.`, 'error');
    } finally {
      btnExtract.disabled = false;
      btnExtractIcon.innerHTML = '⚡';
      btnExtractText.textContent = extractButtonLabel();
    }
  });

  // 6. 학년별 모드 및 자소서 문항 필수 분기 제어
  /** 1·2학년이면 직무기술서(PDF) 로드맵 모드, 3·4학년이면 배포본과 동일한 캡처 추출 화면 */
  function isJuniorMode() {
    return gradeSelect.value === '1학년' || gradeSelect.value === '2학년';
  }

  function extractButtonLabel() {
    return isJuniorMode()
      ? '이미지·스캔 PDF 텍스트 추출하기 (Gemini 무료)'
      : '채용공고 텍스트 추출하기 (Gemini 무료)';
  }

  const MODE_TEXT = {
    senior: {
      title: '② 채용공고 캡처 → 텍스트 추출',
      subtitle: 'Gemini 무료 비전 OCR',
      icon: '📷',
      text: '채용공고 캡처 이미지를 여기에 끌어다 놓거나 클릭하세요',
      subtext: '여러 장 동시 업로드 지원 (PNG, JPG, WEBP) / 클립보드 붙여넣기(Ctrl+V) 지원',
      accept: 'image/*',
      jobDescLabel: '주요 업무 / 담당 업무'
    },
    junior: {
      title: '② 채용공고 / 직무기술서(PDF) → 텍스트 추출',
      subtitle: '1·2학년 로드맵 모드 · 직무기술서 PDF 지원',
      icon: '📷 / 📄',
      text: '채용공고 캡처 이미지 또는 대기업 직무기술서(PDF)를 여기에 끌어다 놓으세요',
      subtext: '삼성전자 DS·DN솔루션즈 직무기술서 PDF는 API 키 없이 바로 발췌 / 이미지(PNG, JPG, WEBP)·스캔 PDF는 Gemini로 추출',
      accept: 'image/*,application/pdf,.pdf',
      jobDescLabel: '주요 업무 / 담당 업무 (Role)'
    }
  };

  function applyScreenMode() {
    const junior = isJuniorMode();
    const t = MODE_TEXT[junior ? 'junior' : 'senior'];
    document.body.classList.toggle('mode-junior', junior);
    document.body.classList.toggle('mode-senior', !junior);
    const setText = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    setText('sec2Title', t.title);
    setText('sec2Subtitle', t.subtitle);
    setText('dropzoneIcon', t.icon);
    setText('dropzoneText', t.text);
    setText('dropzoneSubtext', t.subtext);
    setText('jobDescLabel', t.jobDescLabel);
    fileInput.setAttribute('accept', t.accept);
    if (!btnExtract.disabled || !btnExtractText.textContent.includes('요청 중')) btnExtractText.textContent = extractButtonLabel();

    // 3·4학년으로 바꾸면 PDF는 업로드 목록에서 제외 (배포본처럼 이미지 전용)
    if (!junior && uploadedFiles.some(isPdfFile)) {
      uploadedFiles = uploadedFiles.filter(f => !isPdfFile(f));
      renderPreviews();
      updateExtractButtonState();
      clearPdfJobs();
      showToast('3·4학년 모드는 채용공고 캡처 이미지 전용입니다. 직무기술서 PDF는 1·2학년 모드에서 사용할 수 있습니다.', 'info');
    }
  }

  function updateGradeMode() {
    applyScreenMode();
    const isJunior = (gradeSelect.value === '1학년' || gradeSelect.value === '2학년');
    const essayRequiredBadge = document.getElementById('essayRequiredBadge');
    const essayGradeHint = document.getElementById('essayGradeHint');
    const essayJuniorSubHint = document.getElementById('essayJuniorSubHint');

    if (isJunior) {
      if (essayRequiredBadge) essayRequiredBadge.style.display = 'none';
      if (essayGradeHint) {
        essayGradeHint.textContent = '(1·2학년 선택)';
        essayGradeHint.style.color = '#0284c7';
      }
      if (essayJuniorSubHint) essayJuniorSubHint.style.display = 'block';
      essayQuestionsInput.removeAttribute('required');
      essayQuestionsInput.placeholder = '1·2학년은 공란으로 비워두셔도 됩니다.\n(채용공고/직무기술서의 직무요건·우대사항을 기반으로 전공 공부 및 시기별 스펙 로드맵을 자동으로 완성합니다)';
    } else {
      if (essayRequiredBadge) essayRequiredBadge.style.display = 'inline';
      if (essayGradeHint) {
        essayGradeHint.textContent = '(3·4학년 필수)';
        essayGradeHint.style.color = '#ea580c';
      }
      if (essayJuniorSubHint) essayJuniorSubHint.style.display = 'none';
      essayQuestionsInput.setAttribute('required', 'required');
      essayQuestionsInput.placeholder = '예: 1. 본인이 회사를 선택할 때의 기준은 무엇이며, 왜 당사인지 기술하시오. (700자)\n2. 지원 직무를 수행하기 위해 본인이 노력해온 경험을 서술하시오. (1000자)';
    }
  }

  gradeSelect.addEventListener('change', () => {
    updateGradeMode();
    updatePrompt();
  });

  // 프롬프트 실시간 생성 및 검증
  const inputElements = [
    companyInput, jobInput, orgInput, jobUrlInput, locationInput,
    gradeSelect, majorInput, experienceInput, essayQuestionsInput,
    jobSummaryInput, jobDescInput, qualificationsInput, preferredInput,
    subjectsInput, careerVisionInput
  ];

  inputElements.forEach(el => {
    el.addEventListener('input', updatePrompt);
    el.addEventListener('change', updatePrompt);
  });

  function updatePrompt() {
    const isJunior = (gradeSelect.value === '1학년' || gradeSelect.value === '2학년');
    const data = {
      company: companyInput.value,
      job: jobInput.value,
      org: orgInput.value,
      jobUrl: jobUrlInput.value,
      grade: gradeSelect.value,
      major: majorInput.value,
      experience: experienceInput.value,
      essayQuestions: essayQuestionsInput.value,
      location: locationInput.value,
      summary: jobSummaryInput.value,
      jobDesc: jobDescInput.value,
      qualifications: qualificationsInput.value,
      preferred: preferredInput.value,
      subjects: subjectsInput.value,
      careerVision: careerVisionInput.value
    };

    const missing = [];
    if (!data.company.trim()) missing.push('기업명');
    if (!data.job.trim()) missing.push('지원 직무');
    if (!data.grade.trim()) missing.push('학년');
    if (!data.major.trim()) missing.push('전공');
    if (!isJunior && !data.essayQuestions.trim()) missing.push('자소서 문항');

    if (missing.length === 0) {
      validationBadge.className = 'badge badge-success';
      validationBadge.textContent = isJunior 
        ? '✅ 모든 필수 항목 입력 완료 (1·2학년 로드맵 모드)'
        : '✅ 모든 필수 항목 입력 완료';
    } else {
      validationBadge.className = 'badge badge-warning';
      validationBadge.textContent = `⚠️ 필수 항목 입력 필요: ${missing.join(', ')}`;
    }

    const fullPrompt = buildFullPrompt(data);
    promptPreview.value = fullPrompt;

    const remainingCount = countRemainingPlaceholders(fullPrompt);
    if (remainingCount === 0) {
      placeholderCountBadge.className = 'badge badge-success';
      placeholderCountBadge.textContent = '✅ (입력) 잔여 0개 (정상)';
    } else {
      placeholderCountBadge.className = 'badge badge-warning';
      placeholderCountBadge.textContent = `⚠️ (입력) 잔여 ${remainingCount}개`;
    }
  }

  // 7. 프롬프트 복사 및 AI 직접 이동 로직
  function validateRequiredFields() {
    const isJunior = (gradeSelect.value === '1학년' || gradeSelect.value === '2학년');
    const missing = [];
    if (!companyInput.value.trim()) missing.push({ name: '기업명', el: companyInput });
    if (!jobInput.value.trim()) missing.push({ name: '지원 직무', el: jobInput });
    if (!gradeSelect.value.trim()) missing.push({ name: '학년', el: gradeSelect });
    if (!majorInput.value.trim()) missing.push({ name: '전공', el: majorInput });
    if (!isJunior && !essayQuestionsInput.value.trim()) missing.push({ name: '자소서 문항', el: essayQuestionsInput });
    return missing;
  }

  async function copyPromptToClipboard() {
    const missing = validateRequiredFields();
    if (missing.length > 0) {
      const names = missing.map(m => m.name).join(', ');
      showToast(`필수 항목을 모두 입력해야 이동할 수 있습니다: [${names}]`, 'error');
      missing[0].el.focus();
      missing[0].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return null;
    }

    const textToCopy = promptPreview.value;
    if (!textToCopy) {
      showToast('완성된 프롬프트가 없습니다.', 'error');
      return null;
    }

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        promptPreview.select();
        document.execCommand('copy');
      }
      return textToCopy;
    } catch (err) {
      console.error(err);
      showToast('클립보드 복사에 실패했습니다.', 'error');
      return null;
    }
  }

  if (btnGoChatGPT) {
    btnGoChatGPT.addEventListener('click', async () => {
      const text = await copyPromptToClipboard();
      if (!text) return;

      window.open('https://chatgpt.com/', '_blank');

      const originalHtml = btnGoChatGPT.innerHTML;
      btnGoChatGPT.innerHTML = '<span>✅</span><span>복사 완료! (ChatGPT 열림)</span>';
      showToast('프롬프트 복사 완료! 열린 ChatGPT 창에 Ctrl+V로 붙여넣고 전송하세요.', 'success');

      setTimeout(() => {
        btnGoChatGPT.innerHTML = originalHtml;
      }, 3000);
    });
  }

  if (btnGoGemini) {
    btnGoGemini.addEventListener('click', async () => {
      const text = await copyPromptToClipboard();
      if (!text) return;

      window.open('https://gemini.google.com/app', '_blank');

      const originalHtml = btnGoGemini.innerHTML;
      btnGoGemini.innerHTML = '<span>✅</span><span>복사 완료! (Gemini 열림)</span>';
      showToast('프롬프트 복사 완료! 열린 Gemini 창에 Ctrl+V로 붙여넣고 전송하세요.', 'success');

      setTimeout(() => {
        btnGoGemini.innerHTML = originalHtml;
      }, 3000);
    });
  }

  if (btnGoClaude) {
    btnGoClaude.addEventListener('click', async () => {
      const text = await copyPromptToClipboard();
      if (!text) return;

      window.open('https://claude.ai/new', '_blank');

      const originalHtml = btnGoClaude.innerHTML;
      btnGoClaude.innerHTML = '<span>✅</span><span>복사 완료! (Claude 열림)</span>';
      showToast('프롬프트 복사 완료! 열린 Claude 창에 Ctrl+V로 붙여넣고 전송하세요.', 'success');

      setTimeout(() => {
        btnGoClaude.innerHTML = originalHtml;
      }, 3000);
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      const text = await copyPromptToClipboard();
      if (!text) return;

      const originalHtml = btnCopy.innerHTML;
      btnCopy.innerHTML = '<span>✅</span><span>복사 완료!</span>';
      showToast('완성된 프롬프트가 클립보드에 복사되었습니다.', 'success');

      setTimeout(() => {
        btnCopy.innerHTML = originalHtml;
      }, 2500);
    });
  }

  let toastTimer = null;
  function showToast(message, type = 'success') {
    if (toastTimer) clearTimeout(toastTimer);

    toast.textContent = message;
    let typeClass = 'toast-success';
    if (type === 'error') typeClass = 'toast-error';
    else if (type === 'info') typeClass = 'toast-info';

    toast.className = `toast show ${typeClass}`;

    toastTimer = setTimeout(() => {
      toast.className = 'toast';
    }, 3500);
  }

  loadMyInfo();
  updateGradeMode();
  updatePrompt();
});