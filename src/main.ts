import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { TemplateEngine } from './template-engine';
import { SoomgoBotService } from './soomgo-bot-service';

let mainWindow: BrowserWindow | null = null;
let botService: SoomgoBotService | null = null;

// 공통 경로 설정
const isDev = !app.isPackaged;
const userDataPath = app.getPath('userData');

function getSafePath(filename: string): string {
    // 1. 개발 모드: 프로젝트 루트 폴더의 파일을 직접 사용
    if (isDev) {
        const projectPath = path.join(process.cwd(), filename);
        console.log(`🛠️ [개발 모드] 프로젝트 파일을 사용합니다: ${projectPath}`);
        return projectPath;
    }

    // 2. 배포 모드: AppData 폴더를 사용
    const destPath = path.join(userDataPath, filename);
    
    // ASAR 내부 경로는 app.getAppPath()를 통해 일관되게 접근 가능
    const asarRoot = app.getAppPath();
    const srcPath = path.join(asarRoot, filename);

    try {
        // AppData에 파일이 없고 ASAR 내부에 원본이 있을 때만 복사 (최초 1회)
        if (!fs.existsSync(destPath)) {
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, destPath);
                console.log(`🚚 [배포판] ASAR(${srcPath})에서 초기 데이터를 복사했습니다: ${destPath}`);
            } 
            // 둘 다 없는데 templates.json인 경우만 기본값 생성
            else if (filename === 'templates.json') {
                 const defaultContent = { activeProfile: '기본설정', profiles: { '기본설정': { triggerRules: [], rules: [], sequences: {}, scripts: {} } } };
                 fs.writeFileSync(destPath, JSON.stringify(defaultContent, null, 4));
                 console.log(`✅ [배포판] 원본을 찾지 못해 templates.json 기본값을 생성했습니다: ${destPath}`);
            }
        }
    } catch (e) {
        console.error(`❌ ${filename} 경로 처리 실패:`, e);
    }

    return destPath;
}

const templatesPath = getSafePath('templates.json');
const configPath = getSafePath('config.json');

const engine = new TemplateEngine(templatesPath);

/**
 * Electron 메인 윈도우 생성
 */
async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // index.html 로드
    // dist/main.js 에서 ../src/index.html 을 바라봐야 함 (개발/운영 공통)
    const indexPath = path.join(__dirname, '..', 'src', 'index.html');

    if (fs.existsSync(indexPath)) {
        mainWindow.loadFile(indexPath);
    } else {
        // 패키징 환경 대비 fallback: asar 내부 및 리소스 폴더 탐색
        const fallbacks = [
            path.join(process.resourcesPath, 'app.asar', 'src', 'index.html'),
            path.join(process.resourcesPath, 'app', 'src', 'index.html'),
            path.join(app.getAppPath(), 'src', 'index.html')
        ];

        let loaded = false;
        for (const fallback of fallbacks) {
            if (fs.existsSync(fallback)) {
                mainWindow.loadFile(fallback);
                loaded = true;
                console.log(`✅ Loaded index.html from fallback: ${fallback}`);
                break;
            }
        }

        if (!loaded) {
            console.error('❌ index.html을 찾을 수 없습니다.');
            // 파일이 정 없으면 에러 메시지라도 띄우기 위해 loadURL 사용 가능 (선택적)
        }
    }

    // 개발자 도구 (필요시 활성화)
    // mainWindow.webContents.openDevTools();
}

/**
 * 봇 서비스 초기화
 */
function initializeBotService() {
    if (!botService) {
        botService = new SoomgoBotService(engine, (message) => {
            if (mainWindow) {
                mainWindow.webContents.send('bot-error', message);
            }
        });
    }
}

app.whenReady().then(() => {
    createWindow();
    initializeBotService();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// --- IPC 핸들러 (랜더러 프로세스와 통신) ---

// 봇 시작
ipcMain.handle('start-bot', async () => {
    if (!botService) return { success: false, message: '봇 서비스가 초기화되지 않았습니다.' };
    return await botService.start();
});

// 봇 정지
ipcMain.handle('stop-bot', async () => {
    if (!botService) return { success: false, message: '봇 서비스가 초기화되지 않았습니다.' };
    return await botService.stop();
});

// 미리보기 데이터 가져오기
ipcMain.handle('get-preview', async (event, testData) => {
    if (!botService) return { success: false, message: '봇 서비스가 초기화되지 않았습니다.' };
    return await botService.getPreview(testData);
});

// 로그 목록 가져오기
ipcMain.handle('get-logs', async () => {
    if (!botService) return [];
    return botService.getLogs();
});

// 템플릿 정보 가져오기 (전체 structure)
ipcMain.handle('get-templates', async () => {
    try {
        if (fs.existsSync(templatesPath)) {
            const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
            if (!data.profiles) data.profiles = {};
            return data;
        }
    } catch (e) {
        console.error('❌ 템플릿 로드 실패:', e);
    }
    return { activeProfile: null, profiles: {} };
});

// 템플릿 정보 저장
ipcMain.handle('save-templates', async (event, newTemplates) => {
    try {
        fs.writeFileSync(templatesPath, JSON.stringify(newTemplates, null, 4));
        
        // [핵심] 실행 중인 봇이 있다면 트리거 키워드 즉시 갱신
        if (botService) {
            botService.refreshTriggers();
        }
        
        console.log('✅ 템플릿 저장 및 엔진 동기화 완료');
        return { success: true };
    } catch (e: any) {
        console.error('❌ 템플릿 저장 실패:', e);
        return { success: false, message: e.message };
    }
});

// 이미지 디렉토리 경로 결정 헬퍼
function getImageDir(): string {
    let imageDir = path.join(userDataPath, 'images');

    // 1. config.json 확인
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.imageDir) return config.imageDir;
        } catch (e) { }
    }

    // 2. 프로젝트 로컬 images 폴더 확인 (개발/포터블 환경)
    const localImagesPath = path.join(process.cwd(), 'images');
    if (fs.existsSync(localImagesPath)) {
        return localImagesPath;
    }

    return imageDir;
}

// 설정 정보 가져오기 (이메일 등)
ipcMain.handle('get-config', async () => {
    try {
        let config: any = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        // 실제로 사용 중인 이미지 디렉토리 정보를 함께 전달
        return {
            ...config,
            imageDir: config.imageDir || getImageDir()
        };
    } catch (e) { }
    return { imageDir: getImageDir() };
});

// 설정 업데이트
ipcMain.on('update-config', (event, newConfig) => {
    console.log('✅ 설정 업데이트:', newConfig);
    if (botService) {
        botService.updateConfig(newConfig);
    }
});

// 계정 정보 저장
ipcMain.on('save-credentials', (event, creds) => {
    try {
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        const updatedConfig = { ...config, ...creds };
        fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 4));
        console.log('🔐 계정 정보 업데이트 완료');
    } catch (e) {
        console.error('❌ 계정 저장 실패:', e);
    }
});

// 이미지 파일 목록 가져오기 (재귀적)
ipcMain.handle('get-image-files', async () => {
    try {
        const imageDir = getImageDir();

        if (!fs.existsSync(imageDir)) {
            fs.mkdirSync(imageDir, { recursive: true });
            return [];
        }

        const getFiles = (dir: string, baseDir: string): string[] => {
            let results: string[] = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(getFiles(filePath, baseDir));
                } else {
                    const ext = path.extname(file).toLowerCase();
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
                        results.push(path.relative(baseDir, filePath).replace(/\\/g, '/'));
                    }
                }
            });
            return results;
        };

        return getFiles(imageDir, imageDir);
    } catch (e) {
        console.error('❌ 이미지 목록 로드 실패:', e);
        return [];
    }
});

// 폴더 선택 다이얼로그
ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});
