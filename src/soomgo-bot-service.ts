import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { TemplateEngine, ExtractionData } from './template-engine';
import { AutomationAction } from './services/automation-action';
import { NetworkMonitor } from './services/network-monitor';
import { LoggerService } from './services/logger-service';

/**
 * 숨고 채팅 자동화 봇의 메인 서비스 클래스
 *
 * 동작 흐름:
 *  1. 채팅 목록 주기적 새로고침
 *  2. NetworkMonitor가 last_message로 신규견적/보상 채팅방 판별
 *  3. 신규견적 → 채팅방 진입 → received API에서 고객정보 추출 → 템플릿+이미지 전송
 *  4. 보상     → 채팅방 진입 → 리마인드 문구 전송
 *  5. 전송 완료 → 채팅 목록으로 복귀
 */
export class SoomgoBotService {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private isRunning: boolean = false;

    private automation: AutomationAction | null = null;
    private monitor: NetworkMonitor | null = null;
    private logger: LoggerService;

    private config: { template: string; imageDir: string } | null = null;

    // 주기적 새로고침
    private refreshTimer: NodeJS.Timeout | null = null;
    private refreshInterval: number = 6;
    private isRefreshEnabled: boolean = false;

    // 자동화 중복 실행 방지
    private isAutomationProcessing: boolean = false;
    private currentProcessingChatId: string | null = null;
    private processedChatIds: Set<string> = new Set();
    
    private get userDataPath() {
        return require('electron').app.getPath('userData');
    }

    private get configPath() {
        return path.join(this.userDataPath, 'config.json');
    }

    private readonly PROCESSED_CHATS_FILE = path.join(require('electron').app.getPath('userData'), 'processed_chats.json');

    constructor(
        private engine: TemplateEngine,
        private onError?: (message: string) => void
    ) {
        this.logger = new LoggerService();
        this.loadProcessedChats();
    }

    private notifyError(message: string) {
        console.error(`🔴 Bot Error: ${message}`);
        if (this.onError) this.onError(message);
    }

    // ==========================================
    // 1. LifeCycle & Session Management
    // ==========================================

    async start(): Promise<{ success: boolean; message: string }> {
        if (this.isRunning) {
            return { success: false, message: '이미 봇이 실행 중입니다.' };
        }

        this.isRunning = true;

        try {
            const launchOptions = {
                headless: false,
                slowMo: 100,
                args: [
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-infobars'
                ]
            };

            try {
                this.browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
            } catch {
                try {
                    this.browser = await chromium.launch({ ...launchOptions, channel: 'msedge' });
                } catch {
                    this.browser = await chromium.launch(launchOptions);
                }
            }

            this.context = await this.browser.newContext({
                viewport: null,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            });

            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            this.page = await this.context.newPage();

            this.page.on('close', () => {
                if (this.isRunning) {
                    this.isRunning = false;
                    this.notifyError('브라우저가 예기치 않게 종료되었습니다. 다시 시작해주세요.');
                }
            });

            console.log('🚀 숨고 자동화 서비스 시작');

            // 서브 서비스 초기화
            this.automation = new AutomationAction(this.page, this.engine, this.config?.imageDir);
            await this.setupSafeMode();
            await this.automation.injectStatusIndicator();

            // triggerRules 로드
            const triggerRules = this.engine.getTriggerRules();

            this.monitor = new NetworkMonitor(
                this.page,
                // 신규 견적: received API에서 고객정보 추출 완료 시
                async (data: ExtractionData, customerName: string) => {
                    const chatId = this.page?.url().match(/\/chats\/(\d+)/)?.[1] || 'unknown';

                    if (this.processedChatIds.has(chatId)) {
                        console.log(`ℹ️ 이미 처리된 채팅(Chat ID: ${chatId})으로 신규 요청 응답을 건너뜁니다.`);
                        return;
                    }

                    this.isAutomationProcessing = true;
                    this.currentProcessingChatId = chatId;

                    try {
                        console.log(`🚀 [신규 견적] 자동 응답 실행 시작 (Chat ID: ${chatId})`);
                        await this.automation!.runAutomation(data);
                        this.markChatAsProcessed(chatId);

                        const details = this.engine.getAutomationDetails(data);
                        await this.logger.addLog({
                            chatId,
                            customerName,
                            type: details.targetSequenceName.includes('투인원') || details.targetSequenceName.includes('스탠드') ? '투인원/스탠드' : '일반',
                            message: `신규 견적 자동 응답: ${details.targetSequenceName}`
                        });
                        console.log(`✅ [신규 견적] 자동 응답 완료 및 로그 기록: ${chatId}`);
                    } catch (error: any) {
                        this.notifyError(`신규 견적 자동 응답 오류 (Chat ID: ${chatId}): ${error.message}`);
                    } finally {
                        this.isAutomationProcessing = false;
                        this.currentProcessingChatId = null;
                        // 성공/실패 여부와 관계없이 채팅방으로 들어왔으므로 목록으로 돌아가기 시도
                        await this.automation?.backToChatList();
                    }
                },
                // 보상: 채팅방 ID만 넘어옴 → 채팅방 진입 후 리마인드 전송
                async (chatId: string, customerName: string) => {
                    if (!this.isRunning) return;
                    if (this.processedChatIds.has(chatId)) {
                        console.log(`ℹ️ 이미 처리된 채팅(Chat ID: ${chatId})으로 보상 처리를 건너뜁니다.`);
                        return;
                    }

                    this.isAutomationProcessing = true;
                    this.currentProcessingChatId = chatId;

                    // [중요] 처리 시작 직후 마킹하여 handleReceivedRequest 콜백 중복 실행 방지
                    this.markChatAsProcessed(chatId);

                    try {
                        console.log(`🚀 [보상] 페이지 이동 및 리마인드 전송 (Chat ID: ${chatId})`);
                        await this.page?.goto(
                            `https://soomgo.com/pro/chats/${chatId}?from=compensation`,
                            { waitUntil: 'domcontentloaded', timeout: 15000 }
                        );

                        await this.automation!.runAutomationByName('미접속_보상_시퀀스', customerName);
                        this.markChatAsProcessed(chatId);

                        await this.logger.addLog({
                            chatId,
                            customerName,
                            type: '보상(48H)',
                            message: '미접속 보상 리마인드 전송 완료'
                        });
                        console.log(`✅ [보상] 리마인드 전송 완료 및 로그 기록: ${chatId}`);
                    } catch (error: any) {
                        this.notifyError(`보상 처리 오류 (Chat ID: ${chatId}): ${error.message}`);
                    } finally {
                        this.isAutomationProcessing = false;
                        this.currentProcessingChatId = null;
                        await this.automation?.backToChatList();
                    }
                },
                triggerRules.newChatKeywords,
                triggerRules.compensationKeywords
            );

            // 채팅방 진입 시 콜백 — 신규견적은 received API 인터셉트로 처리되므로
            // 여기서는 자동화가 진행 중이 아닐 때만 로그 출력
            this.monitor.init(async () => {
                const currentUrl = this.page?.url() || '';
                const chatId = currentUrl.match(/\/chats\/(\d+)/)?.[1] || 'unknown';
                console.log(`📌 채팅방 진입 감지 (Chat ID: ${chatId})`);
            });

            // 페이지 이동 및 로그인
            await this.page.goto('https://soomgo.com/login');
            await this.performLogin();

            // 새로고침 타이머 설정
            if (fs.existsSync(this.configPath)) {
                const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                if (cfg.refreshInterval !== undefined) this.refreshInterval = cfg.refreshInterval;
                if (cfg.isRefreshEnabled !== undefined) this.isRefreshEnabled = cfg.isRefreshEnabled;
            }

            if (this.isRefreshEnabled) {
                this.setPeriodicRefresh(true);
            }

            this.isRunning = true;
            await this.logger.addLog({
                chatId: '-',
                customerName: '-',
                type: '시스템',
                message: '🤖 숨고 매크로 서비스 가동 시작'
            });

            return { success: true, message: '봇이 성공적으로 시작되었습니다.' };

        } catch (error: any) {
            this.isRunning = false;
            console.error('❌ 봇 시작 에러:', error);
            if (this.page && this.page.url().includes('/login')) {
                this.notifyError('로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
                await this.stop();
                return { success: false, message: '로그인 실패' };
            }
            this.notifyError(error.message || '봇 시작 실패');
            await this.stop();
            return { success: false, message: error.message || '봇 시작 실패' };
        }
    }

    async stop(): Promise<{ success: boolean; message: string }> {
        try {
            if (this.page) await this.page.close();
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
        } catch (e: any) {
            console.error('⚠️ 브라우저 종료 중 에러:', e);
        } finally {
            this.stopRefreshTimer();
            this.page = null;
            this.context = null;
            this.browser = null;
            this.automation = null;
            this.monitor = null;
            this.isRunning = false;
        }
        return { success: true, message: '봇이 정지되었습니다.' };
    }

    // ==========================================
    // 2. Login & Config
    // ==========================================

    private async performLogin() {
        if (!this.page) return;

        try {
            if (!fs.existsSync(this.configPath)) {
                console.warn('⚠️ config.json 파일을 찾을 수 없어 자동 로그인을 건너뜁니다.');
                return;
            }

            const loginConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            if (!loginConfig.email || !loginConfig.password || loginConfig.email.includes('YOUR_EMAIL')) return;

            console.log('🔐 자동 로그인 시도 중...');
            await this.page.waitForSelector('input[placeholder="example@soomgo.com"]', { timeout: 5000 });
            await this.page.fill('input[placeholder="example@soomgo.com"]', loginConfig.email);
            await this.page.fill('input[placeholder="비밀번호를 입력해 주세요."]', loginConfig.password);
            await this.page.click('button[type="submit"]');

            try {
                await this.page.waitForURL('**/requests/received**', { timeout: 15000 });
                console.log('🏁 로그인 성공!');
                await this.page.goto('https://soomgo.com/pro/chats');
            } catch {
                console.warn('⚠️ 로그인 대기 시간 초과');
            }
        } catch (e) {
            console.error('❌ 자동 로그인 중 에러:', e);
        }
    }

    private async setupSafeMode(forcedValue?: boolean) {
        if (!this.page) return;

        let safeMode = forcedValue;
        if (safeMode === undefined) {
            safeMode = true;
            if (fs.existsSync(this.configPath)) {
                const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                safeMode = cfg.safeMode !== false;
            }
        }

        if (safeMode) {
            console.log('🛡️ [안전 모드] 활성화');
            this.automation?.setSafeMode(true);
            await this.page.route('**/api.soomgo.com/v2/chats/*/files', async (route) => {
                await route.abort();
            });
        } else {
            console.log('🔓 [일반 모드] 활성화');
            this.automation?.setSafeMode(false);
            await this.page.unroute('**/api.soomgo.com/v2/chats/*/files');
        }
    }

    async updateConfig(newConfig: { template: string; imageDir: string; refreshInterval?: number; isRefreshEnabled?: boolean; safeMode?: boolean }) {
        this.config = newConfig;

        if (newConfig.safeMode !== undefined) {
            await this.setupSafeMode(newConfig.safeMode);
        }
        if (newConfig.refreshInterval !== undefined) {
            this.refreshInterval = newConfig.refreshInterval;
        }
        if (newConfig.isRefreshEnabled !== undefined) {
            this.isRefreshEnabled = newConfig.isRefreshEnabled;
            if (this.isRunning) {
                if (this.isRefreshEnabled) this.startRefreshTimer();
                else this.stopRefreshTimer();
            }
        }

        console.log(`📂 설정 업데이트 완료 (새로고침: ${this.isRefreshEnabled ? 'ON' : 'OFF'}, ${this.refreshInterval}초)`);
    }

    // ==========================================
    // 3. Preview & Logs
    // ==========================================

    async getPreview(data: ExtractionData) {
        const details = this.engine.getAutomationDetails(data);
        const baseDir = this.config?.imageDir || path.join(this.userDataPath, 'images');

        let previewMessage = '';
        let previewImagePath = '이미지 없음';
        let imageExists = false;

        for (const step of details.sequence) {
            const resolved = this.engine.resolveStep(step, details);
            if (resolved.type === 'text') {
                previewMessage += (previewMessage ? '\n\n' : '') + resolved.content;
            } else if (resolved.type === 'image') {
                const finalPath = path.resolve(baseDir, resolved.content.endsWith('.png') ? resolved.content : `${resolved.content}.png`);
                if (fs.existsSync(finalPath)) {
                    previewImagePath = path.basename(finalPath);
                    imageExists = true;
                }
            }
        }

        return { ...details, message: previewMessage, imagePath: previewImagePath, imageExists };
    }

    getLogs() {
        return this.logger.getLogs();
    }

    // ==========================================
    // 4. Processed Chats
    // ==========================================

    private loadProcessedChats() {
        try {
            if (fs.existsSync(this.PROCESSED_CHATS_FILE)) {
                const data = JSON.parse(fs.readFileSync(this.PROCESSED_CHATS_FILE, 'utf8'));
                this.processedChatIds = new Set(data);
                console.log(`✅ 처리된 채팅방 목록 로드: ${this.processedChatIds.size}건`);
            }
        } catch (e) {
            console.error('⚠️ 처리된 채팅방 목록 로드 실패:', e);
        }
    }

    private markChatAsProcessed(chatId: string) {
        if (chatId === 'unknown') return;
        this.processedChatIds.add(chatId);
        this.monitor?.markChatAsProcessed(chatId);
        try {
            fs.writeFileSync(this.PROCESSED_CHATS_FILE, JSON.stringify(Array.from(this.processedChatIds), null, 2));
        } catch (e) {
            console.error('⚠️ 처리된 채팅방 목록 저장 실패:', e);
        }
    }

    // ==========================================
    // 5. Refresh Timer
    // ==========================================

    public setPeriodicRefresh(enabled: boolean) {
        this.isRefreshEnabled = enabled;
        console.log(`🔄 주기적 새로고침 ${enabled ? '활성화' : '비활성화'}`);
        if (enabled) {
            this.scheduleNextRefresh();
        } else {
            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = null;
            }
        }
    }

    private scheduleNextRefresh() {
        if (!this.isRefreshEnabled) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);

        const baseInterval = this.refreshInterval * 1000;
        const jitter = (Math.random() - 0.5) * 4000;
        const delay = Math.max(15000, baseInterval + jitter);

        this.refreshTimer = setTimeout(async () => {
            if (!this.isRefreshEnabled) return;

            if (this.isAutomationProcessing) {
                console.log('⏳ 자동화 진행 중으로 인해 이번 새로고침을 건너뜁니다.');
                this.scheduleNextRefresh();
                return;
            }

            const currentUrl = this.page?.url() || '';
            if (currentUrl.includes('/pro/chats/') && !currentUrl.endsWith('/chats')) {
                console.log('⏳ 채팅방 내부이므로 새로고침을 건너뜁니다.');
                this.scheduleNextRefresh();
                return;
            }

            try {
                console.log(`🔄 새로고침 실행 (${(delay / 1000).toFixed(1)}초 대기 후)`);
                await this.page?.reload({ waitUntil: 'domcontentloaded' });
            } catch (error) {
                console.error('❌ 새로고침 중 오류:', error);
            }

            this.scheduleNextRefresh();
        }, delay);
    }

    private startRefreshTimer() { this.setPeriodicRefresh(true); }
    private stopRefreshTimer() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}