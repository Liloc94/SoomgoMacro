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
    const destPath = path.join(userDataPath, filename);
    
    // 개발 모드가 아니고, 파일이 유저 데이터 폴더에 없으면 앱 실행 폴더나 리소스 폴더에서 복사
    if (!fs.existsSync(destPath)) {
        try {
            const srcPath = isDev 
                ? path.join(process.cwd(), filename)
                : path.join(process.resourcesPath, 'app', filename);
            
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, destPath);
                console.log(`✅ ${filename} copied to UserData: ${destPath}`);
            } else if (filename.endsWith('.json')) {
                // 원본도 없는 경우 기본값으로 생성
                fs.writeFileSync(destPath, JSON.stringify(filename === 'templates.json' ? { activeProfile: null, profiles: {} } : {}, null, 4));
                console.log(`✅ ${filename} created with default values at: ${destPath}`);
            }
        } catch (e) {
            console.error(`❌ ${filename} 초기화 실패:`, e);
        }
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
        // 엔진에도 즉시 리로드 지시 (getAutomationDetails 내에서 이미 로드하긴 함)
        console.log('✅ 템플릿 저장 및 엔진 동기화 완료');
        return { success: true };
    } catch (e: any) {
        console.error('❌ 템플릿 저장 실패:', e);
        return { success: false, message: e.message };
    }
});

// 설정 정보 가져오기 (이메일 등)
ipcMain.handle('get-config', async () => {
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {}
    return {};
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
        let imageDir = path.join(userDataPath, 'images');

        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.imageDir) imageDir = config.imageDir;
        }

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
