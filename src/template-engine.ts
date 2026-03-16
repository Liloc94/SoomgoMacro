import * as fs from 'fs';

export interface ExtractionData {
    useType: string;
    brand: string;
    type: string;
    quantity: string;
}

export interface StepCondition {
    field: 'brand' | 'type' | 'useType' | 'quantity';
    operator: 'equals' | 'contains' | 'not_equals';
    value: string;
}

export interface Step {
    type: 'text' | 'image';
    script?: string;
    file?: string;
    conditions?: StepCondition[];
}

export interface AutomationDetails {
    sequence: Step[];
    targetSequenceName: string;
    cleanBrand: string;
    rawType: string;
    quantity: string;
    data: ExtractionData;
}

/**
 * templates.json 구조 예시:
 *
 * {
 *   "activeProfile": "본점",
 *   "profiles": {
 *     "본점": {
 *       "triggerRules": {
 *         "newChat": {
 *           "keywords": ["✨화이트크리닉입니다✨"]
 *         },
 *         "compensation": {
 *           "keywords": ["미접속 견적 보상", "보상해드렸습니다"]
 *         }
 *       },
 *       "rules": [
 *         { "keywords": ["스탠드", "스탠드형"], "target": "스탠드_응답_시퀀스" },
 *         { "keywords": ["투인원", "2in1"],     "target": "투인원_응답_시퀀스" }
 *       ],
 *       "sequences": { ... },
 *       "scripts": { ... }
 *     }
 *   }
 * }
 */
export class TemplateEngine {
    private config: any = {};
    private activeProfileName: string = '본점';

    constructor(private templatesPath: string) {
        this.load();
    }

    public load() {
        try {
            if (fs.existsSync(this.templatesPath)) {
                const fileData = fs.readFileSync(this.templatesPath, 'utf8');
                this.config = JSON.parse(fileData);
                this.activeProfileName = this.config.activeProfile || '본점';
                console.log(`✅ 템플릿 엔진 로드 완료 (활성 프로필: ${this.activeProfileName})`);
            } else {
                console.warn('⚠️ 템플릿 파일을 찾을 수 없습니다:', this.templatesPath);
            }
        } catch (e) {
            console.error('❌ 템플릿 엔진 로드 에러:', e);
        }
    }

    private getActiveProfile() {
        return this.config.profiles?.[this.activeProfileName] || Object.values(this.config.profiles || {})[0];
    }

    /**
     * 브랜드명을 표준화합니다.
     */
    private normalizeBrand(brand: string): string {
        const brandMatch = brand.match(/^([^(]+)/);
        const clean = (brandMatch ? brandMatch[1] : brand).trim().replace(/[/\\?%*:|"<>]/g, '');

        const brandMap: Record<string, string> = {
            '삼성': '삼성전자',
            '엘지': 'LG전자',
            'lg': 'LG전자',
            '위니아': '위니아전자',
            '대우': '대우전자',
            '캐리어': '캐리어'
        };

        return brandMap[clean] || brandMap[clean.toLowerCase()] || clean;
    }

    /**
     * 채팅 목록 트리거 키워드를 반환합니다.
     * NetworkMonitor가 last_message 판별에 사용합니다.
     */
    public getTriggerRules(): { newChatKeywords: string[]; compensationKeywords: string[] } {
        this.load();
        const profile = this.getActiveProfile();
        const rules = profile?.triggerRules || [];

        return {
            newChatKeywords: rules.find((r: any) => r.target === '__AUTO__')?.keywords || [],
            compensationKeywords: rules.find((r: any) => r.target === '미접속_보상_시퀀스')?.keywords || []
        };
    }

    /**
     * API 반환값(브랜드/종류)을 분석하여 실행할 시퀀스와 상세 정보를 결정합니다.
     */
    public getAutomationDetails(data: ExtractionData): AutomationDetails {
        this.load();
        const profile = this.getActiveProfile();
        const { brand: rawBrand, type: rawType, quantity } = data;

        const cleanBrand = this.normalizeBrand(rawBrand);
        const typeStr = rawType.replace(/\s+/g, '').toLowerCase();

        let targetSequenceName = '기본_응답';

        // 브랜드/종류 불명확한 경우
        if (
            cleanBrand.includes('잘 모르겠음') || typeStr.includes('잘모르겠음') ||
            cleanBrand.includes('알 수 없음') || typeStr.includes('알수없음')
        ) {
            if (profile.sequences?.['미확인_안내_시퀀스']) {
                targetSequenceName = '미확인_안내_시퀀스';
            }
        }

        // rules 매칭 (API 반환값 기준)
        if (targetSequenceName === '기본_응답' && profile.rules) {
            for (const rule of profile.rules) {
                const matched = rule.keywords.some((kw: string) => {
                    const kwLower = kw.toLowerCase();
                    if (typeStr.includes(kwLower)) return true;
                    const normalizedKw = this.normalizeBrand(kw);
                    if (cleanBrand.includes(normalizedKw) || normalizedKw.includes(cleanBrand)) return true;
                    return false;
                });
                if (matched) {
                    targetSequenceName = rule.target;
                    break;
                }
            }
        }

        // 시퀀스 조건부 필터링
        const fullSequence = profile.sequences?.[targetSequenceName] || profile.sequences?.['기본_응답'] || [];
        const sequence = fullSequence.filter((step: Step) => {
            if (!step.conditions || step.conditions.length === 0) return true;
            return step.conditions.every(cond => {
                let fieldValue = '';
                switch (cond.field) {
                    case 'brand': fieldValue = cleanBrand; break;
                    case 'type': fieldValue = rawType; break;
                    case 'useType': fieldValue = data.useType || ''; break;
                    case 'quantity': fieldValue = data.quantity || ''; break;
                    default: fieldValue = rawType;
                }

                if (cond.operator === 'equals') return fieldValue === cond.value;
                if (cond.operator === 'not_equals') return fieldValue !== cond.value;
                if (cond.operator === 'contains') return fieldValue.includes(cond.value);
                return true;
            });
        });

        return { sequence, targetSequenceName, cleanBrand, rawType, quantity, data };
    }

    /**
     * 시퀀스 이름만으로 실행 정보를 가져옵니다. (보상 시퀀스 등에 사용)
     */
    public getAutomationDetailsByName(sequenceName: string): any {
        this.load();
        const profile = this.getActiveProfile();
        const sequence = profile.sequences?.[sequenceName] || [];
        return {
            targetSequenceName: sequenceName,
            sequence,
            cleanBrand: 'N/A',
            rawType: 'N/A',
            quantity: 'N/A',
            data: {}
        };
    }

    /**
     * 스텝의 변수({brand}, {type}, {quantity})를 실제 값으로 치환합니다.
     */
    public resolveStep(step: Step, details: AutomationDetails): { type: 'text' | 'image'; content: string } {
        const profile = this.getActiveProfile();

        if (step.type === 'text') {
            let text = profile.scripts?.[step.script || ''] || '';
            text = text
                .replace(/{brand}/g, details.cleanBrand)
                .replace(/{type}/g, details.rawType)
                .replace(/{quantity}/g, details.quantity);
            return { type: 'text', content: text };
        } else {
            let fileName = step.file || '';
            fileName = fileName.replace(/{brand}/g, details.cleanBrand);
            return { type: 'image', content: fileName };
        }
    }

    /**
     * 텍스트에서 고객 요청 데이터를 추출합니다. (DOM 파싱 fallback용)
     */
    public extractData(text: string): ExtractionData {
        const find = (keywords: string[]) => {
            for (const kw of keywords) {
                const regex = new RegExp(`${kw}\\s*[:：]?\\s*([^\\n\\r|]+)`, 'i');
                const match = text.match(regex);
                if (match) return match[1].trim();
            }
            return '잘 모르겠음';
        };

        return {
            useType: find(['어떤 용도의 에어컨인가요', '용도']),
            brand: find(['어떤 브랜드 제품인가요', '가전 브랜드', '제품 브랜드', '브랜드']),
            type: find(['에어컨 종류가 무엇인가요', '에어컨 종류', '종류']),
            quantity: find(['에어컨 수량', '갯수', '대수', '몇대'])
        };
    }
}