/**
 * Gemini API 단일 호출 및 상세 진단 모듈
 * - 무분별한 다중 재시도 루프 제거 (429 할당량 초과 및 400/404 연쇄 오류 방지)
 * - 단 1회 명시적 모델 호출 및 상세 에러 진단(상태 코드, 모델명, Google API 원문 메시지) 반환
 */

/**
 * Gemini API 통신 상세 에러 객체
 */
class GeminiApiError extends Error {
  constructor(message, { model, status, statusText, apiMessage, errorDetails }) {
    super(message);
    this.name = 'GeminiApiError';
    this.model = model;
    this.status = status;
    this.statusText = statusText;
    this.apiMessage = apiMessage;
    this.errorDetails = errorDetails;
  }
}

/**
 * File 객체를 base64 문자열과 유효한 mimeType으로 변환합니다.
 * mimeType이 비어있을 경우 발생하는 400 Bad Request를 방지합니다.
 * @param {File} file 
 * @returns {Promise<{inlineData: {data: string, mimeType: string}}>}
 */
function fileToGenerativePart(file) {
  return new Promise((resolve, reject) => {
    let mimeType = file.type;
    if (!mimeType || mimeType.trim() === '') {
      const name = (file.name || '').toLowerCase();
      if (name.endsWith('.png')) mimeType = 'image/png';
      else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mimeType = 'image/jpeg';
      else if (name.endsWith('.webp')) mimeType = 'image/webp';
      else if (name.endsWith('.pdf')) mimeType = 'application/pdf';
      else mimeType = 'image/png';
    } else if (file.name && file.name.toLowerCase().endsWith('.pdf')) {
      mimeType = 'application/pdf';
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64Data = reader.result.split(',')[1];
      resolve({
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * API 키 및 선택된 모델의 통신 가능 여부를 단 1회 가볍게 테스트합니다.
 * (이미지 업로드 없이도 API 키와 모델 유효성을 0.5초 만에 확인)
 * @param {string} apiKey 
 * @param {string} model 
 * @returns {Promise<{success: boolean, model: string}>}
 */
async function testGeminiConnection(apiKey, model = 'gemini-3.6-flash') {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('API Key를 먼저 입력해주세요.');
  }

  const cleanKey = apiKey.trim();
  const targetModel = (model && model !== 'auto') ? model.trim() : 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${cleanKey}`;

  const requestBody = {
    contents: [
      {
        parts: [{ text: "ping" }]
      }
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const apiMessage = errorData.error?.message || `HTTP ${response.status} 오류`;
    throw new GeminiApiError(apiMessage, {
      model: targetModel,
      status: response.status,
      statusText: response.statusText,
      apiMessage: apiMessage,
      errorDetails: errorData.error
    });
  }

  return {
    success: true,
    model: targetModel
  };
}

/**
 * 채용공고 캡처 이미지(또는 PDF 페이지를 렌더링한 이미지)에서
 * 공통 직무 스키마(직무 요약/Role/전공별 추천과목/Requirements/Pluses/Career Vision)를 단 1회 추출합니다.
 * PDF는 app.js에서 선택한 직무 페이지만 이미지로 변환해 넘겨주므로, 문서 전체를 보내지 않습니다.
 * @param {string} apiKey Google AI Studio Gemini API Key
 * @param {File[]} imageFiles 이미지 파일 배열
 * @param {string} targetModel 사용자가 선택한 단일 모델 (기본값 gemini-3.6-flash)
 * @param {string} targetJobInfo 선택한 직무 (예: "메모리사업부 - 반도체공정기술 (p.6~8)")
 * @param {string} myMajor 내 전공 (추천과목 중 내 전공 줄 선택용)
 */
async function extractJobPostingText(apiKey, imageFiles, targetModel = 'gemini-3.6-flash', targetJobInfo = '', myMajor = '') {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Google AI Studio Gemini API Key를 먼저 입력해주세요.');
  }

  if (!imageFiles || imageFiles.length === 0) {
    throw new Error('채용공고 캡처 이미지를 1장 이상 등록해주세요.');
  }

  const cleanKey = apiKey.trim();
  const modelToUse = (targetModel && targetModel !== 'auto') ? targetModel.trim() : 'gemini-3.6-flash';

  const imageParts = await Promise.all(
    Array.from(imageFiles).map(file => fileToGenerativePart(file))
  );

  let targetPromptAddon = '';
  if (targetJobInfo && targetJobInfo.trim()) {
    targetPromptAddon = `\n\n[특별 타겟팅 지시]: 첨부 자료에서 반드시 [${targetJobInfo.trim()}] 직무에 해당하는 내용만 추출하세요. 다른 직무의 내용은 절대 섞지 마세요.`;
  }

  const promptText = `당신은 대한민국 대기업(삼성전자, SK하이닉스, 현대자동차, DN솔루션즈 등) 채용공고 및 직무기술서(Job Description) 분석 전문가입니다.
첨부된 ${imageParts.length}장의 이미지(채용공고 캡처 또는 직무기술서 페이지)에서 텍스트를 정밀하게 판독하여 추출하세요.${targetPromptAddon}

반드시 아래 JSON 포맷으로만 응답하세요:
{
  "company": "회사명 (보이면)",
  "division": "사업부/부문/Job Group (보이면)",
  "job": "직무명",
  "location": "근무지 (보이면)",
  "summary": "직무 요약 / 직무 소개 문장 (원문 그대로)",
  "roles": [ { "title": "업무 소제목 (예: 8대 공정기술 개발 및 생산관리)", "items": ["세부 업무 원문", "..."] } ],
  "subjects_by_major": { "전공 라벨 (예: 기계, 전기전자(HW))": "추천 과목 원문" },
  "eligible_majors": "모집전공 / 유관전공 원문",
  "requirements": ["지원 자격·필수 요건 항목 원문"],
  "pluses": ["우대 사항 항목 원문"],
  "career_vision": ["Career Vision / 성장 경로 항목 원문"]
}

[추출 규칙]
1. 'Role', 'Role & Responsibility', '담당 업무', '주요 업무'는 roles에 넣고, 굵은 소제목(●, ▪ 등)마다 별도 객체로 나누세요. 한 페이지에 여러 소제목이 있으면 빠짐없이 모두 넣으세요.
2. 'Recommended Subject(전공별 추천과목)'는 전공 라벨별로 subjects_by_major에 넣으세요. 없으면 {}.
3. 'Requirements', '지원 자격', '요건'은 requirements, '유관전공 및 학위'의 전공 문구는 eligible_majors에 넣으세요.
4. 'Pluses', '우대 사항'은 pluses, 'Career Vision'은 career_vision에 넣으세요.
5. 원문의 의미나 표현을 바꾸거나 요약하지 말고, 글머리 기호(-, • 등)만 빼고 원문 그대로 옮겨 적으세요.
6. 여러 이미지에 걸쳐 있으면 순서대로 빠짐없이 취합하세요.
7. 항목이 명시되어 있지 않으면 빈 문자열 "" 또는 빈 배열 []을 넣으세요.
8. 마크다운 코드블록(\`\`\`json) 없이 순수 JSON만 반환하세요.`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: promptText },
          ...imageParts
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  // 단 1회만 직접 호출 (숨은 재시도 루프 제거)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${cleanKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const apiMessage = errorData.error?.message || `HTTP ${response.status} 오류`;

    throw new GeminiApiError(apiMessage, {
      model: modelToUse,
      status: response.status,
      statusText: response.statusText,
      apiMessage: apiMessage,
      errorDetails: errorData.error
    });
  }

  const result = await response.json();
  const rawText = result.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

  if (!rawText) {
    throw new Error('Gemini로부터 응답 텍스트를 받지 못했습니다.');
  }

  // JSON 파싱 (```json 마크다운 래핑 처리 포함)
  let cleanJson = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed = null;
  try {
    parsed = JSON.parse(cleanJson);
  } catch (e) {
    parsed = null;
  }

  // JSON이 깨진 경우: 섹션 제목 기반 일반 파서로 구조화 시도
  const arr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
    : (typeof v === 'string' && v.trim() ? v.split('\n').map(x => x.replace(/^[-•▪·]\s*/, '').trim()).filter(Boolean) : []);

  let job;
  if (parsed && typeof parsed === 'object') {
    job = {
      company: parsed.company || '',
      division: parsed.division || '',
      job: parsed.job || '',
      location: parsed.location || '',
      summary: parsed.summary || '',
      roles: Array.isArray(parsed.roles)
        ? parsed.roles.map(r => ({ title: (r && r.title) || '', items: arr(r && r.items) }))
        : (parsed.job_description ? [{ title: '', items: arr(parsed.job_description) }] : []),
      subjectsByMajor: (parsed.subjects_by_major && typeof parsed.subjects_by_major === 'object') ? parsed.subjects_by_major : {},
      eligibleMajors: parsed.eligible_majors || '',
      majorsRequired: [],
      requirements: arr(parsed.requirements || parsed.qualifications),
      pluses: arr(parsed.pluses || parsed.preferred),
      careerVision: arr(parsed.career_vision)
    };
  } else if (window.JDParser) {
    job = JDParser.parseGenericText(rawText);
  } else {
    job = { summary: '', roles: [{ title: '', items: [rawText] }], subjectsByMajor: {}, requirements: [], pluses: [], careerVision: [] };
  }

  const fields = window.JDParser
    ? JDParser.toFieldTexts(job, myMajor)
    : { summary: job.summary, jobDesc: rawText, qualifications: '', preferred: '', subjects: '', careerVision: '' };

  return {
    company: job.company || '',
    job: job.job || '',
    location: job.location || '',
    summary: fields.summary,
    job_description: fields.jobDesc,
    qualifications: fields.qualifications,
    preferred: fields.preferred,
    subjects: fields.subjects,
    career_vision: fields.careerVision,
    usedModel: modelToUse
  };
}
