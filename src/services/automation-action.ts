import { Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { TemplateEngine, ExtractionData } from '../template-engine';

/**
 * 브라우저 페이지 내의 자동화 동작(메시지 입력, 전송, 업로드 등)을 수행하는 클래스
 */
export class AutomationAction {
    private isSafeMode: boolean = false;

    constructor(
        private page: Page,
        private engine: TemplateEngine,
        private imageDir?: string
    ) { }

    setImageDir(dir: string) {
        this.imageDir = dir;
        console.log(`📸 이미지 전송 경로가 설정되었습니다: ${dir}`);
    }

    setSafeMode(enabled: boolean) {
        this.isSafeMode = enabled;
    }

    async runAutomation(extraction: ExtractionData) {
        try {
            const details = this.engine.getAutomationDetails(extraction);
            await this.executeSequence(details);
        } catch (error) {
            console.error('⚠️ 자동 응답 액션 에러:', error);
        }
    }

    /**
     * 특정 시퀀스 이름을 기반으로 자동화를 실행합니다.
     * @param sequenceName 실행할 시퀀스 이름
     * @param customerName 고객명 (로그용)
     */
    async runAutomationByName(sequenceName: string, customerName: string) {
        try {
            const details = this.engine.getAutomationDetailsByName(sequenceName);
            await this.executeSequence(details);
        } catch (error) {
            console.error(`⚠️ 시퀀스(${sequenceName}) 실행 에러:`, error);
        }
    }

    /**
     * 공통 시퀀스 실행 로직
     */
    private async executeSequence(details: any) {
        const inputSelector = 'textarea[placeholder*="메시지"], textarea[placeholder*="메세지"], textarea[name="message-input"], .chat-input textarea';
        await this.page.waitForSelector(inputSelector, { timeout: 10000 });

        console.log(`🚀 [시퀀스 시작] 명칭: ${details.targetSequenceName}`);

        let imageBuffer: string[] = [];

        for (let i = 0; i < details.sequence.length; i++) {
            const step = details.sequence[i];
            const resolved = this.engine.resolveStep(step, details);

            if (resolved.type === 'image') {
                imageBuffer.push(resolved.content);
                
                // 다음 스텝이 이미지가 아니거나 마지막 스텝이면 업로드 수행
                const nextStep = details.sequence[i + 1];
                const nextResolved = nextStep ? this.engine.resolveStep(nextStep, details) : null;
                
                if (!nextResolved || nextResolved.type !== 'image') {
                    await this.page.waitForTimeout(this.getRandomDelay());
                    await this.uploadImages(imageBuffer);
                    await this.clickSend();
                    imageBuffer = [];
                }
            } else if (resolved.type === 'text') {
                await this.page.waitForTimeout(this.getRandomDelay());
                await this.page.fill(inputSelector, resolved.content);
                await this.clickSend();
                console.log(`⌨️ 텍스트 전송: ${resolved.content.substring(0, 15)}...`);
            }
        }

        // 전송 안정화 후 복귀
        await this.page.waitForTimeout(800);
        await this.backToChatList();
    }

    private getRandomDelay() {
        return Math.floor(Math.random() * (500 - 100 + 1)) + 100;
    }

    // sendCompensationMessage() 메서드는 이제 시퀀스 시스템으로 통합되어 제거되었습니다.

    /**
     * 지정된 파일명들을 기반으로 이미지를 복수 업로드합니다.
     * @param fileNames 업로드할 이미지 파일 이름 배열
     */
    private async uploadImages(fileNames: string[]) {
        // [수정] 배포 환경에서도 고정적으로 이미지를 찾을 수 있도록 APPDATA 경로 우선 활용
        const userDataPath = require('electron').app.getPath('userData');
        const defaultImagesPath = path.join(userDataPath, 'images');
        
        // 사용자가 명시적으로 설정한 경로가 있다면 사용, 없으면 APPDATA 내의 images 폴더 사용
        const baseDir = this.imageDir || defaultImagesPath;
        const filePaths: string[] = [];

        console.log(`🔍 이미지 검색 위치: ${baseDir}`);

        for (const fileName of fileNames) {
            // 확장자가 없으면 .png 추가
            const finalFileName = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
            const finalPath = path.resolve(baseDir, finalFileName);

            if (fs.existsSync(finalPath)) {
                filePaths.push(finalPath);
            } else {
                // [Fallback] 혹시 모를 로컬 실행 시의 images 폴더도 체크
                const localFallback = path.resolve(process.cwd(), 'images', finalFileName);
                if (fs.existsSync(localFallback)) {
                    filePaths.push(localFallback);
                } else {
                    console.warn(`❌ 이미지를 찾을 수 없음: ${finalPath}`);
                }
            }
        }

        if (filePaths.length === 0) return;

        if (this.isSafeMode) {
            console.log(`🛡️ [시뮬레이션] 이미지 복수 업로드 생략: ${fileNames.join(', ')}`);
            return;
        }

        console.log(`📸 이미지 첨부 (${filePaths.length}장): ${fileNames.join(', ')}`);
        await this.page.setInputFiles('input[type="file"]', filePaths);
        
        // 업로드 후 브라우저 처리 대기 (파일 개수에 따라 대기 시간 조정)
        const waitTime = filePaths.length > 1 ? 2500 : 1500;
        await this.page.waitForTimeout(waitTime);
    }

    /**
     * 전송 버튼을 즉시 찾아 클릭합니다. (DOM 직접 제어)
     */
    private async clickSend() {
        if (this.isSafeMode) {
            console.log('🛡️ [시뮬레이션] 전송 버튼 클릭 생략');
            return;
        }

        await this.page.$$eval('button[type="submit"], .btn-submit, .chat-input button', (btns: any) => {
            const sendBtn = btns.find((b: any) =>
                b.innerText.includes('전송') || b.textContent.includes('전송') || b.type === 'submit'
            );
            if (sendBtn) sendBtn.click();
            else if (btns[0]) btns[0].click();
        });
        console.log('✅ 전송 버튼 클릭 완료');
    }

    /**
     * 작업 완료 후 채팅 목록 페이지로 복귀합니다.
     */
    public async backToChatList() {
        try {
            await this.page.goto('https://soomgo.com/pro/chats', {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            console.log('🔙 채팅 목록으로 복귀 완료');
        } catch (e: any) {
            if (e.message.includes('ERR_ABORTED') || e.message.includes('interrupted')) {
                console.log('ℹ️ 채팅 목록 복귀 중단 (다른 내비게이션 발생)');
            } else {
                console.warn('⚠️ 채팅 목록 복귀 실패:', e.message);
            }
        }
    }

    /**
     * 채팅방 페이지에서 고객 요청 데이터(브랜드, 타입 등)를 추출합니다.
     */
    async extractCustomerData(): Promise<{ data: ExtractionData | null, customerName: string }> {
        let customerName = '고객';
        try {
            await this.page.waitForSelector('.chat-message-customer-info, .quote-request-item, .chat-header-title, .user-name', { timeout: 5000 });

            const textContent = await this.page.evaluate(() => {
                const infoArea = document.querySelector('.chat-message-customer-info') || document.body;
                return infoArea.textContent || '';
            });

            customerName = await this.page.$eval('.chat-header-title, .user-name, h5.name', (el: any) => el.innerText.trim()).catch(() => '고객');

            // 엔진을 통해 텍스트에서 데이터 추출
            return {
                data: this.engine.extractData(textContent),
                customerName
            };
        } catch (e) {
            console.warn('⚠️ 고객 데이터 자동 추출 실패 (수동 연동 필요할 수 있음)');
            return { data: null, customerName };
        }
    }

    /**
     * 브라우저 상단에 매크로 작동 중임을 알리는 상태 바를 주입합니다.
     */
    async injectStatusIndicator() {
        if (!this.page) return;

        const isSafe = this.isSafeMode;

        // 브라우저 내부에서 실행될 스크립트
        const script = (safeMode: boolean) => {
            const BANNER_ID = 'soomgo-automation-banner';

            const inject = () => {
                // 상단 배너 색상 및 텍스트 정의
                const bgColor = safeMode ? '#f59e0b' : '#00c7ae';
                const emoji = safeMode ? '🧪' : '🤖';
                const text = safeMode
                    ? '화이트크리닉 자동화 [테스트 모드] 가동 중 (실제 전송 안됨)'
                    : '화이트크리닉 자동화 매크로 가동 중 (실제 전송 모드)';

                let banner = document.getElementById(BANNER_ID);

                // 1. 이미 존재한다면 내용과 색상만 업데이트
                if (banner) {
                    if (banner.getAttribute('data-safe') !== String(safeMode)) {
                        banner.style.backgroundColor = bgColor;
                        banner.setAttribute('data-safe', String(safeMode));

                        const contentSpan = banner.querySelector('.banner-content');
                        if (contentSpan) {
                            contentSpan.innerHTML = `
                                <span style="font-size: 16px;">${emoji}</span>
                                ${text}
                                <span style="width: 8px; height: 8px; background-color: #fff; border-radius: 50%; animation: pulse-blink 1.5s infinite;"></span>
                            `;
                        }
                    }

                    if (document.body && document.body.style.marginTop !== '32px') {
                        document.body.style.setProperty('margin-top', '32px', 'important');
                    }
                    return;
                }

                // 2. 존재하지 않는 경우 생성 및 주입
                banner = document.createElement('div');
                banner.id = BANNER_ID;
                banner.setAttribute('data-safe', String(safeMode));

                Object.assign(banner.style, {
                    position: 'fixed',
                    top: '0',
                    left: '0',
                    width: '100%',
                    height: '32px',
                    backgroundColor: bgColor,
                    color: 'white',
                    zIndex: '2147483647',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    fontFamily: 'Pretendard, -apple-system, sans-serif',
                    pointerEvents: 'none',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                    letterSpacing: '-0.5px',
                    transition: 'background-color 0.3s'
                });

                banner.innerHTML = `
                    <span class="banner-content" style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 16px;">${emoji}</span>
                        ${text}
                        <span style="width: 8px; height: 8px; background-color: #fff; border-radius: 50%; animation: pulse-blink 1.5s infinite;"></span>
                    </span>
                    <style>
                        @keyframes pulse-blink {
                            0% { opacity: 0.4; transform: scale(0.9); }
                            50% { opacity: 1; transform: scale(1.1); }
                            100% { opacity: 0.4; transform: scale(0.9); }
                        }
                        /* 숨고 내부 레이아웃 틀어짐 방지 */
                        body { margin-top: 32px !important; }
                        header, .pro-header, nav, [role="navigation"] { top: 32px !important; }
                    </style>
                `;

                if (document.documentElement) {
                    document.documentElement.appendChild(banner);
                }
            };

            // SPA 방식의 페이지 이동 시 배너가 사라지는 것을 방지하기 위해 주기적으로 체크
            setInterval(inject, 1000);

            // 초기 실행
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', inject);
            } else {
                inject();
            }
        };

        // 1. 앞으로 열릴 모든 페이지에 자동 주입
        await (this.page as any).addInitScript(script, isSafe);
        // 2. 현재 열려있는 페이지에 즉시 주입 시도
        try {
            await (this.page as any).evaluate(script, isSafe);
        } catch (e) { }
    }
}
