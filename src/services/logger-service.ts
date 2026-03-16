import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
    timestamp: string;
    chatId: string;
    customerName: string;
    type: string;
    message: string;
}

export class LoggerService {
    private logDir: string;
    private logFilePath: string;

    constructor() {
        this.logDir = path.resolve(process.cwd(), 'logs');
        this.logFilePath = path.resolve(this.logDir, 'automation_history.json');
        this.init();
        this.cleanupOldLogs();
    }

    private init() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        if (!fs.existsSync(this.logFilePath)) {
            fs.writeFileSync(this.logFilePath, JSON.stringify([], null, 2));
        }
    }

    /**
     * 새로운 자동화 로그를 저장합니다.
     */
    public async addLog(entry: Omit<LogEntry, 'timestamp'>) {
        try {
            const fullEntry: LogEntry = {
                ...entry,
                timestamp: new Date().toISOString()
            };

            const logs: LogEntry[] = JSON.parse(fs.readFileSync(this.logFilePath, 'utf8'));
            logs.unshift(fullEntry); // 최신 로그가 위로 오게 추가
            
            // 최근 500개만 유지 (파일 크기 관리)
            const limitedLogs = logs.slice(0, 500);
            
            fs.writeFileSync(this.logFilePath, JSON.stringify(limitedLogs, null, 2));
            return limitedLogs;
        } catch (e) {
            console.error('❌ 로그 저장 에러:', e);
            return [];
        }
    }

    /**
     * 저장된 모든 로그를 가져옵니다.
     */
    public getLogs(): LogEntry[] {
        try {
            return JSON.parse(fs.readFileSync(this.logFilePath, 'utf8'));
        } catch (e) {
            return [];
        }
    }

    /**
     * 한 달(30일) 이상 된 로그를 정리합니다.
     * (현재는 단일 파일 기반이므로, 파일 내용을 필터링하는 방식으로 구현)
     */
    private cleanupOldLogs() {
        try {
            const logs: LogEntry[] = JSON.parse(fs.readFileSync(this.logFilePath, 'utf8'));
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const filteredLogs = logs.filter(log => new Date(log.timestamp) > thirtyDaysAgo);
            
            if (logs.length !== filteredLogs.length) {
                fs.writeFileSync(this.logFilePath, JSON.stringify(filteredLogs, null, 2));
                console.log(`🧹 오래된 로그 정리 완료 (${logs.length - filteredLogs.length}건 삭제)`);
            }
        } catch (e) {
            console.error('❌ 로그 정리 중 에러:', e);
        }
    }
}
