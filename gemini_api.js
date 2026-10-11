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
      else mimeType = 'image/png';
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
 * 1장 이상의 채용공고 캡처 이미지에서 [업무내용, 지원자격, 우대사항]을 단 1회 정확하게 추출합니다.
 * @param {string} apiKey Google AI Studio Gemini API Key
 * @param {File[]} imageFiles 이미지 파일 배열
 * @param {string} targetModel 사용자가 선택한 단일 모델 (기본값 gemini-3.6-flash)
 * @returns {Promise<{job_description: string, qualifications: string, preferred: string, usedModel: string}>}
 */
async function extractJobPostingText(apiKey, imageFiles, targetModel = 'gemini-3.6-flash') {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Google AI Studio Gemini API Key를 먼저 입력해주세요.');
  }

  if (!imageFiles || imageFiles.length === 0) {
    throw new Error('채용공고 캡처 이미지를 1장 이상 등록해주세요.');
  }

  const cleanKey = apiKey.trim();
  const modelToUse = (targetModel && targetModel !== 'auto') ? targetModel.trim() : 'gemini-3.6-flash';

  // 이미지들을 메모리에서 base64로 변환
  const imageParts = await Promise.all(
    Array.from(imageFiles).map(file => fileToGenerativePart(file))
  );

  const promptText = `당신은 대한민국 대기업 채용공고 분석 및 OCR 추출 전문가입니다.
첨부된 ${imageParts.length}장의 채용공고 캡처 이미지에서 텍스트를 정밀하게 판독하여 추출하세요.

반드시 아래 JSON 포맷으로만 응답하세요:
{
  "job_description": "담당 업무, 주요 업무, 수행 업무 내용 (원문 텍스트 그대로)",
  "qualifications": "지원 자격, 필수 요건, 지원 대상 (원문 텍스트 그대로)",
  "preferred": "우대 사항, 기타 사항, 우대 전공 및 자격증 (원문 텍스트 그대로)"
}

[추출 규칙]
1. 원문의 의미나 표현을 바꾸거나 임의로 요약하지 마시고, 항목별 글머리 기호(-, • 등)를 포함하여 원문 그대로 옮겨 적으세요.
2. 여러 장의 이미지에 걸쳐 있는 경우 순서대로 빠짐없이 취합하세요.
3. 이미지에 해당 항목(예: 우대사항)이 명시되어 있지 않은 경우에만 빈 문자열 ""을 넣으세요.
4. 마크다운 코드블록 없이 순수 JSON만 반환하세요.`;

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
      temperature: 0.1
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
  const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!rawText) {
    throw new Error('Gemini로부터 응답 텍스트를 받지 못했습니다.');
  }

  // JSON 파싱 (```json 마크다운 래핑 처리 포함)
  let cleanJson = rawText.trim();
  if (cleanJson.startsWith('```json')) {
    cleanJson = cleanJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleanJson.startsWith('```')) {
    cleanJson = cleanJson.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  let parsed = {};
  try {
    parsed = JSON.parse(cleanJson);
  } catch (e) {
    parsed = {
      job_description: rawText,
      qualifications: '',
      preferred: ''
    };
  }

  return {
    job_description: parsed.job_description || '',
    qualifications: parsed.qualifications || '',
    preferred: parsed.preferred || '',
    usedModel: modelToUse
  };
}
