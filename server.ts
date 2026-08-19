import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Lazy initialize GenAI instance
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

const WELFARE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    category_main: {
      type: Type.STRING,
      enum: [
        "생계지원",
        "돌봄지원",
        "고용/주거지원",
        "건강/정신건강",
        "금융/법률지원",
        "기타",
      ],
      description:
        "메인 카테고리 (생계지원, 돌봄지원, 고용/주거지원, 건강/정신건강, 금융/법률지원, 기타 중 1개 선택)",
    },
    category_sub: {
      type: Type.STRING,
      description:
        "내용에 맞게 2~3단어로 자유롭게 생성된 서브 카테고리 (예: 일상돌봄, 고용지원, 바우처, 긴급생계 등)",
    },
    project_name: {
      type: Type.STRING,
      description: "사업명 (명확하고 간결하게 정제)",
    },
    purpose: {
      type: Type.STRING,
      description: "사업 목적 (1~2문장으로 요약)",
    },
    target_audience: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "지원 대상 (주요 요건 위주로 요약하여 배열 형태로 작성)",
    },
    support_content: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "지원 내용 (금액, 지원 항목 등 핵심 내용 요약, 배열 형태로 작성)",
    },
    period: {
      type: Type.STRING,
      description: "신청/접수 기간 (날짜 위주로 명확히 작성, 텍스트에 없으면 '해당 내용 없음')",
    },
    contact: {
      type: Type.STRING,
      description: "문의처 및 담당 부서 (전화번호, 이메일, 웹사이트 등, 텍스트에 없으면 '해당 내용 없음')",
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "검색에 유용할 만한 해시태그 3~5개 (예: ['#일상돌봄', '#청년지원', '#가사서비스'])",
    },
  },
  required: [
    "category_main",
    "category_sub",
    "project_name",
    "purpose",
    "target_audience",
    "support_content",
    "period",
    "contact",
    "tags",
  ],
};

const SYSTEM_INSTRUCTION = `당신은 공공기관 및 복지분야 사업 안내서(PDF 텍스트)를 분석하여 웹페이지에 출력하기 좋은 형태로 데이터를 추출하고 가공하는 '데이터 구조화 전문가'입니다.

사용자가 사업 정보가 담긴 텍스트 또는 문서를 입력하면, 아래의 규칙에 따라 분석하고 반드시 [JSON] 형식으로만 결과를 출력하십시오. 다른 부가적인 설명은 하지 마십시오.

[카테고리 분류 규칙]
사업의 성격을 분석하여 다음 중 가장 적합한 1개의 '메인 카테고리'와 '서브 카테고리'를 지정하십시오.
- 메인 카테고리 후보: [생계지원, 돌봄지원, 고용/주거지원, 건강/정신건강, 금융/법률지원, 기타]
- 서브 카테고리 후보: 내용에 맞게 2~3단어로 자유롭게 생성 (예: 일상돌봄, 고용지원, 바우처 등)

[추출해야 할 데이터 항목 (JSON Key)]
1. "category_main": 위에서 지정한 메인 카테고리
2. "category_sub": 위에서 지정한 서브 카테고리
3. "project_name": 사업명 (명확하고 간결하게 정제)
4. "purpose": 사업 목적 (1~2문장으로 요약)
5. "target_audience": 지원 대상 (주요 요건 위주로 요약하여 배열(Array) 형태로 작성)
6. "support_content": 지원 내용 (금액, 지원 항목 등 핵심 내용 요약, 배열(Array) 형태로 작성)
7. "period": 신청/접수 기간 (날짜 위주로 명확히 작성)
8. "contact": 문의처 및 담당 부서 (전화번호, 이메일, 웹사이트 등)
9. "tags": 검색에 유용할 만한 해시태그 3~5개 (배열(Array) 형태로 작성, '#' 기호 포함 권장)

[출력 형식 제한]
- 반드시 유효한 JSON 포맷으로만 출력할 것.
- 내용이 텍스트에 없는 경우 "해당 내용 없음"으로 표기할 것.`;

// Extract Endpoint
app.post("/api/extract", async (req, res) => {
  try {
    const { text, fileBase64, mimeType } = req.body;

    if (!text && !fileBase64) {
      return res.status(400).json({
        error: "분석할 안내서 텍스트 또는 문서 파일(PDF/이미지)을 제공해 주세요.",
      });
    }

    const ai = getGeminiClient();

    const parts: any[] = [];

    if (fileBase64 && mimeType) {
      // Clean base64 header if included
      const cleanData = fileBase64.replace(/^data:[^;]+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType,
          data: cleanData,
        },
      });
    }

    if (text) {
      parts.push({
        text: `[사업 안내서 텍스트]\n${text}`,
      });
    } else {
      parts.push({
        text: "제공된 문서(PDF/이미지)의 공공·복지사업 안내서 내용을 정밀 분석하여 요구된 JSON 규격으로 구조화해 주세요.",
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: { parts },
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: WELFARE_SCHEMA,
      },
    });

    const responseText = response.text || "{}";
    const structuredData = JSON.parse(responseText);

    return res.json({
      success: true,
      data: structuredData,
      rawJson: responseText,
    });
  } catch (error: any) {
    console.error("Extraction error:", error);
    return res.status(500).json({
      error: error?.message || "데이터 추출 중 오류가 발생했습니다.",
    });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
