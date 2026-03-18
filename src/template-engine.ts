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

                // 단일 사용자 환경: 첫 번째 프로필을 최우선으로 사용
                const profileNames = Object.keys(this.config.profiles || {});
                if (profileNames.length > 0) {
                    this.activeProfileName = this.config.activeProfile || profileNames[0];
                } else {
                    this.activeProfileName = '기본설정';
                }

                console.log(`✅ 템플릿 엔진 로드 완료 (활성 프로필: ${this.activeProfileName})`);
            } else {
                console.warn('⚠️ 템플릿 파일을 찾을 수 없습니다:', this.templatesPath);
            }
        } catch (e) {
            console.error('❌ 템플릿 엔진 로드 에러:', e);
        }
    }

    private getActiveProfile() {
        if (!this.config.profiles) this.config.profiles = {};

        // 지정된 프로필이 없으면 첫 번째 프로필 반환
        const active = this.config.profiles[this.activeProfileName];
        if (active) return active;

        const firstProfile = Object.values(this.config.profiles)[0];
        return firstProfile || null;
    }

    /**
     * 문자열에서 모든 공백과 특수문자를 제거하여 비교를 용이하게 합니다.
     */
    private cleanText(text: string): string {
        if (!text) return '';
        return text.replace(/\s+/g, '').replace(/[/\\?%*:|"<>]/g, '').toLowerCase();
    }

    /**
     * 브랜드명을 표준화합니다.
     */
    private normalizeBrand(brand: string): string {
        if (!brand) return '잘 모르겠음';

        // (괄호) 이전의 텍스트만 추출하여 정리
        const brandMatch = brand.match(/^([^(]+)/);
        const raw = (brandMatch ? brandMatch[1] : brand).trim().toLowerCase();

        // 부분 일치 검사를 통한 표준화
        if (raw.includes('삼성') || raw.includes('samsung')) return '삼성전자';
        if (raw.includes('엘지') || raw.includes('lg')) return 'LG전자';
        if (raw.includes('위니아') || raw.includes('대우') || raw.includes('캐리어') || raw.includes('carrier')) return '기타 / 알 수 없음';

        // 매칭되는 게 없으면 기본 클린업만 수행하여 반환
        return raw.trim();
    }

    /**
     * 채팅 목록 트리거 키워드를 반환합니다.
     * NetworkMonitor가 last_message 판별에 사용합니다.
     */
    public getTriggerRules(): { newChatKeywords: string[]; compensationKeywords: string[] } {
        this.load();
        const profile = this.getActiveProfile();
        const rules = profile?.triggerRules || [];

        // 동일 타겟에 대해 여러 블록이 있을 경우를 대비하여 filter + flatMap 사용
        const getKeywords = (target: string) =>
            rules.filter((r: any) => r.target === target)
                .flatMap((r: any) => r.keywords || []);

        return {
            newChatKeywords: getKeywords('__AUTO__'),
            compensationKeywords: getKeywords('미접속_보상_시퀀스')
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
        const typeStr = rawType.toLowerCase();

        // 비교를 위해 모든 공백과 특수문자를 제거한 버전 준비
        const ultraCleanBrand = this.cleanText(cleanBrand);
        const ultraCleanType = this.cleanText(rawType);

        let targetSequenceName = '기본_응답';

        // 브랜드/종류 불명확한 경우 (우선 순위 체크)
        if (
            ultraCleanBrand.includes('잘모르겠음') || ultraCleanType.includes('잘모르겠음') ||
            ultraCleanBrand.includes('알수없음') || ultraCleanType.includes('알수없음')
        ) {
            if (profile.sequences?.['미확인_안내_시퀀스']) {
                targetSequenceName = '미확인_안내_시퀀스';
            }
        }

        // rules 매칭 (가중치 기반 최적 매칭)
        if (targetSequenceName === '기본_응답' && profile.rules) {
            let bestScore = 0;
            let bestTarget = '기본_응답';

            for (const rule of profile.rules) {
                let currentScore = 0;

                // 해당 규칙의 모든 키워드를 검사하여 일치하는 개수(점수) 계산
                rule.keywords.forEach((kw: string) => {
                    const ultraCleanKw = this.cleanText(kw);
                    const normalizedKw = this.normalizeBrand(kw);
                    const ultraCleanNormalizedKw = this.cleanText(normalizedKw);

                    let matched = false;
                    // 1. 타입 문자열 매칭 (공백 제거 버전)
                    if (ultraCleanType.includes(ultraCleanKw)) {
                        currentScore += 1;
                        matched = true;
                    }

                    // 2. 브랜드명 매칭 (표준화 명칭 포함 여부, 공백 제거 버전)
                    // 이미 타입에서 매칭되었더라도 브랜드가 다를 수 있으므로 별도 체크 (가중치 합산)
                    if (ultraCleanBrand.includes(ultraCleanNormalizedKw) || ultraCleanNormalizedKw.includes(ultraCleanBrand)) {
                        currentScore += 1;
                        matched = true;
                    }
                });

                // 더 구체적인(점수가 높은) 규칙이 있다면 갱신. 점수가 같으면 뒤에 정의된 규칙 우선(사용자 추가분)
                if (currentScore >= bestScore && currentScore > 0) {
                    bestScore = currentScore;
                    bestTarget = rule.target;
                }
            }

            if (bestScore > 0) {
                targetSequenceName = bestTarget;
                console.log(`🎯 최적 매칭 발견: ${targetSequenceName} (점수: ${bestScore})`);
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