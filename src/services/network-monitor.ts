import { Page, Response } from 'playwright';
import { ExtractionData } from '../template-engine';

/**
 * 네트워크 응답을 가로채고 분석하여 트리거를 발생시키는 클래스
 *
 * 동작 방식:
 *  - 채팅 목록 API 감시: last_message로 신규견적/보상 채팅방 판별 후 입장 트리거
 *  - 채팅방 진입 후: received API에서 고객 정보 자동 추출 → onNewRequest 콜백
 *  - 보상 채팅방: onCompensation 콜백
 */
export class NetworkMonitor {
    private processedChatIds: Set<string> = new Set();
    private processedRequestIds: Set<string> = new Set();

    constructor(
        private page: Page,
        private onNewRequest: (data: ExtractionData, customerName: string) => Promise<void>,
        private onCompensation: (chatId: string, customerName: string) => Promise<void>,
        // 신규견적 트리거 키워드 (templates.json의 triggerRules.newChat.keywords)
        private newChatKeywords: string[],
        // 보상 트리거 키워드 (templates.json의 triggerRules.compensation.keywords)
        private compensationKeywords: string[]
    ) { }

    /**
     * 네트워크 응답 모니터링을 초기화합니다.
     */
    init(onPageNavigated?: () => Promise<void>) {
        this.page.on('response', async (response: Response) => {
            if (!this.page || this.page.isClosed()) return;

            const url = response.url();

            try {
                // 1. 채팅 목록 감시 → 입장 트리거 판별
                if (url.includes('/chats') && url.includes('role=provider')) {
                    await this.handleChatList(response);
                }

                // 2. 채팅방 진입 후 고객 정보 추출
                if (url.includes('api.soomgo.com/v2/requests/received/')) {
                    await this.handleReceivedRequest(response, url);
                }

            } catch (e) {
                // 파싱 에러 등 무시
            }
        });

        // 채팅방 진입 감지
        if (onPageNavigated) {
            this.page.on('framenavigated', async (frame) => {
                if (frame === this.page.mainFrame()) {
                    const url = this.page.url();
                    if (url.includes('/pro/chats/') && !url.endsWith('/chats')) {
                        await onPageNavigated();
                    }
                }
            });
        }
    }

    /**
     * 채팅 목록 API를 파싱하여 입장해야 할 채팅방을 판별합니다.
     *
     * 판별 기준:
     *  - 신규견적: last_message에 newChatKeywords 중 하나 포함
     *  - 보상:     last_message에 compensationKeywords 중 하나 포함
     */
    private async handleChatList(response: Response) {
        try {
            if (response.status() !== 200) return;

            const body = await response.body().catch(() => null);
            if (!body) return;

            const data = JSON.parse(body.toString('utf8'));
            const chats = data?.results || data?.response?.items || data?.items || [];

            if (chats.length === 0) return;

            for (const chat of chats) {
                const chatId = String(chat.id);
                const lastMessage: string = chat.last_message || '';
                const customerName: string = chat.user?.name || '고객';

                // 이미 처리된 채팅방 스킵
                if (this.processedChatIds.has(chatId)) continue;

                // 계약 완료된 채팅방은 건드리지 않음
                if (chat.quote?.is_hired) continue;

                // 신규 견적 판별
                const isNewChat = this.newChatKeywords.some(kw => lastMessage.includes(kw));

                // 보상 판별
                const isCompensation = this.compensationKeywords.some(kw => lastMessage.includes(kw));

                if (isNewChat) {
                    console.log(`✨ 신규 견적 감지 (Chat ID: ${chatId}, Customer: ${customerName})`);
                    this.processedChatIds.add(chatId);
                    // 채팅방으로 이동 → framenavigated 이벤트 → onPageNavigated 콜백
                    // → handleReceivedRequest에서 고객정보 추출 후 자동 응답
                    await this.navigateToChat(chatId, 'new');

                } else if (isCompensation) {
                    console.log(`💡 미접속 보상 감지 (Chat ID: ${chatId}, Customer: ${customerName})`);
                    this.processedChatIds.add(chatId);
                    await this.onCompensation(chatId, customerName);
                }
            }
        } catch (e: any) {
            const errStr = e.toString();
            const isIgnorable = errStr.includes('Protocol error') ||
                errStr.includes('No resource with given identifier') ||
                errStr.includes('Target closed');
            if (!isIgnorable) {
                console.error('❌ 채팅 목록 파싱 에러:', e);
            }
        }
    }

    /**
     * 채팅방 진입 후 received API에서 고객 정보를 추출합니다.
     */
    private async handleReceivedRequest(response: Response, url: string) {
        try {
            if (response.status() !== 200) return;

            const body = await response.body().catch(() => null);
            if (!body) return;

            const data = JSON.parse(body.toString('utf8'));

            if (data?.response?.items) {
                const requestId = data.response.id || url.split('/').pop() || 'unknown';

                if (this.processedRequestIds.has(requestId)) return;
                this.processedRequestIds.add(requestId);

                const items = data.response.items;
                const customerName: string = data.response.user?.name || '고객';

                const extraction: ExtractionData = {
                    useType: this.findAnswer(items, ['어떤 용도', '용도의 에어컨', '용도']),
                    brand: this.findAnswer(items, ['어떤 브랜드', '브랜드 제품', '브랜드']),
                    type: this.findAnswer(items, ['에어컨 종류', '종류가 무엇']),
                    quantity: this.findAnswer(items, ['에어컨 수량', '갯수', '대수', '몇대'])
                };

                console.log(`✅ 고객 정보 추출 완료: 브랜드=${extraction.brand}, 종류=${extraction.type}, 고객=${customerName}`);
                await this.onNewRequest(extraction, customerName);
            }
        } catch (e) {
            // 파싱 에러 무시
        }
    }

    /**
     * 채팅방으로 이동합니다.
     */
    private async navigateToChat(chatId: string, reason: 'new' | 'compensation') {
        try {
            await this.page.goto(
                `https://soomgo.com/pro/chats/${chatId}?from=${reason}`,
                { waitUntil: 'domcontentloaded', timeout: 15000 }
            );
        } catch (e: any) {
            if (e.message.includes('ERR_ABORTED') || e.message.includes('interrupted')) {
                console.log('ℹ️ 내비게이션 중단됨 (정상적인 흐름)');
            } else {
                console.error(`❌ 채팅방 이동 에러 (${chatId}):`, e.message);
            }
        }
    }

    /**
     * 질문 목록에서 키워드에 맞는 답변을 추출합니다.
     */
    private findAnswer(items: any[], keywords: string[]): string {
        const item = items.find((i: any) =>
            keywords.some(k => i.question?.includes(k))
        );
        return item?.answer || '잘 모르겠음';
    }

    /**
     * 외부에서 처리된 채팅방 ID를 동기화합니다.
     */
    public markChatAsProcessed(chatId: string) {
        this.processedChatIds.add(chatId);
    }
}