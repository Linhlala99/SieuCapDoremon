require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process'); // Giữ lại exec, nhưng không khuyến khích dùng trực tiếp
const fsPromises = require('fs/promises'); // Thay fs-extra bằng fs/promises
const path = require('path');
const ngrok = require('ngrok');
const winston = require('winston');
const os = require('os');
const multer = require('multer');
const FileAnalyzer = require('./FileAnalyzer.js'); // Giữ lại để đảm bảo tính toàn vẹn nếu bạn muốn dùng lại
const FileManager = require('./fileManager.js'); // Giữ lại để đảm bảo tính toàn vẹn nếu bạn muốn dùng lại
const cv = require('opencv4nodejs'); // Thêm thư viện OpenCV
const { chromium } = require('playwright'); // Thêm thư viện Playwright

// Khởi tạo Logger (Ưu tiên AdvancedLogger, fallback về Winston nếu không tìm thấy)
const logLevel = process.env.LOG_LEVEL || 'info';
let logger;
try {
    const AdvancedLogger = require('./AdvancedLogger.js');
    logger = new AdvancedLogger();
    console.log("✅ Logger initialized with AdvancedLogger.");
} catch (error) {
    console.warn("⚠️ AdvancedLogger not found, falling back to Winston.");
    logger = winston.createLogger({
        level: logLevel,
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, message }) => {
                return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
            })
        ),
        transports: [
            new winston.transports.Console(),
            new winston.transports.File({ filename: 'logs/server.log' })
        ]
    });
}

// Khởi tạo Redis client
const Redis = require('ioredis');

class RedisSingleton {
    constructor() {
        if (!RedisSingleton.instance) {
            this.client = new Redis({
                host: isWindows ? "localhost" : "127.0.0.1",
                port: 6379
            });
            RedisSingleton.instance = this;
        }
        return RedisSingleton.instance;
    }
}

const redis = new RedisSingleton().client;

// Kiểm tra kết nối Redis
async function checkRedisConnection() {
    try {
        await redis.ping();
        logger.info("✅ Redis is connected");
    } catch (error) {
        logger.error("⚠️ Redis is not connected. Some features may not work.");
        process.exit(1);
    }
}
checkRedisConnection();

// Kiểm tra trạng thái Redis
async function checkRedis() {
    try {
        await redis.ping();
        logger.info("✅ Redis is connected");
    } catch (error) {
        logger.error("⚠️ Redis is not connected. Exiting...");
        process.exit(1);
    }
}
checkRedis();

// Ghi lại tiến trình vào Redis
async function saveProcess(pid, command) {
    await redis.set(`process:${pid}`, JSON.stringify({ command, startedAt: Date.now() }));
}

// Tự động khởi động lại tiến trình khi hệ thống khởi động lại
async function restartProcesses() {
    const keys = await redis.keys('process:*');
    for (const key of keys) {
        const processInfo = JSON.parse(await redis.get(key));
        const child = spawn(processInfo.command, { shell: true, detached: true, stdio: 'ignore' });
        child.unref();
        logger.info(`Restarted process: ${processInfo.command} (PID: ${child.pid})`);
    }
}
restartProcesses();

// Khởi tạo Express và Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: e8 // 100MB buffer size
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Đảm bảo thư mục logs và uploads tồn tại
const ensureDir = async (dir) => {
    try {
        await fsPromises.mkdir(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`⚠️ Error creating directory ${dir}:`, error.message);
        }
    }
};

(async () => {
    await ensureDir('logs');
    await ensureDir('uploads');
    await ensureDir('screenshots');
    await ensureDir(path.join(__dirname, 'templates')); // Tạo thư mục templates
})();

// Route gốc để kiểmtra server
app.get('/', (req, res) => {
    res.json({ message: 'Server is running', status: 'OK' });
});

// Cấu hình upload file
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// ========================== 🚀 QUẢN LÝ & THAO TÁC TỆP TIN 🚀 ==========================

// Upload file
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    logger.info(`File uploaded: ${req.file.originalname}`);
    res.json({ message: 'File uploaded successfully', file: req.file });
});

// Download file
app.get('/api/files/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    res.download(filePath, (err) => {
        if (err) {
            logger.error(`Error downloading file ${req.params.filename}:`, err);
            res.status(500).json({ error: 'File download failed' });
        } else {
            logger.info(`Downloaded file: ${req.params.filename}`);
        }
    });
});

// Delete file
app.delete('/api/files/:filename', async (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    try {
        await fsPromises.unlink(filePath);
        logger.info(`Deleted file: ${req.params.filename}`);
        res.json({ message: 'File deleted successfully' });
    } catch (error) {
        logger.error(`Error deleting file: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ========================== ⚙️ QUẢN LÝ & GIÁM SÁT HỆ THỐNG ⚙️ ==========================

// Monitor hệ thống
app.get('/api/system/monitor', (req, res) => {
    const memoryUsage = {
        total: os.totalmem(),
        free: os.freemem(),
        usage: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2)
    };
    res.json({
        cpu: os.cpus(),
        memory: memoryUsage,
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch(),
        networkInterfaces: os.networkInterfaces()
    });
});

// ========================== 💻 QUẢN LÝ TERMINAL & THỰC THI LỆNH 💻 ==========================
const { Queue, Worker } = require('bullmq');
const redisConnection = { host: "127.0.0.1", port: 6379 };

const terminalQueue = new Queue("terminalQueue", { connection: redisConnection });

const terminalWorker = new Worker("terminalQueue", async job => {
    const { command } = job.data;
    return new Promise((resolve, reject) => {
        spawn(command, {shell: true})
        .on('exit', (code) => {
            if (code !== 0) {
                logger.error(`Command execution failed with code ${code}`);
                reject(`Command failed with code ${code}`);
            }
            else {
                logger.info(`Command execution completed: ${command}`);
                resolve();
            }
        });
    });
}, { connection: redisConnection });

// Danh sách các tiến trình đang chạy (cho async commands)
const activeProcesses = new Map();
const MAX_PROCESSES = 10; // Giới hạn tối đa 10 tiến trình chạy nền

// Danh sách các lệnh an toàn được phép thực thi
const allowedCommands = isWindows
  ? ["dir", "whoami", "systeminfo", "tasklist"] // Lệnh dành cho Windows
  : ["ls", "pwd", "uptime", "df", "whoami", "top"]; // Lệnh dành cho Linux

// Giới hạn thời gian thực thi cho từng lệnh
const commandTimeouts = {
    'ls': 5,      // 5 giây
    'top': 30,    // 30 giây
    'ping': 10    // 10 giây
};

/**
 * Thực thi lệnh terminal nhanh chóng (có timeout)
 */
app.post('/api/terminal/execute', async (req, res) => {
    const { command } = req.body;
    const timeout = commandTimeouts[command] || 15; // Mặc định 15 giây

    if (!command || command.trim() === "") {
        logger.warn("Command cannot be empty");
        return res.status(400).json({ error: "Command cannot be empty" });
    }

    if (!allowedCommands.includes(command.split(" ")[0])) {
        return res.status(403).json({ error: "Command not allowed" });
    }

    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const commandArgs = isWindows ? ["/c", command] : ["-c", command];
    
    const child = spawn(shell, commandArgs, { shell: true });
    
    let output = "";
    child.stdout.on("data", (data) => {
        output += data.toString();
    });

    child.stderr.on("data", (error) => {
        output += error.toString();
    });

    child.on("close", (code) => {
        res.json({ output, exitCode: code });
    });
});

/**
 * Thực thi lệnh dài hạn chạy nền (async)
 */
app.post('/api/terminal/execute_async', async (req, res) => {
    if (activeProcesses.size >= MAX_PROCESSES) {
        return res.status(429).json({ error: "Too many background processes running. Please wait." });
    }

    const command = req.body.command;
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const commandArgs = isWindows ? ["/c", command] : ["-c", command];
    const child = spawn(shell, commandArgs, { shell: true, detached: true, stdio: 'pipe' });

    child.unref();
    activeProcesses.set(child.pid, child);
    await saveProcess(child.pid, command);

    logger.info(`Running background command: ${command} (PID: ${child.pid})`);
    res.json({ message: "Command is running in background", pid: child.pid });

    setTimeout(() => {
        if (activeProcesses.has(child.pid)) {
            try {
                child.kill();
                activeProcesses.delete(child.pid);
                redis.del(`process:${child.pid}`);
                logger.warn(`Killed process ${child.pid} due to timeout`);
            } catch (error) {
                logger.error(`Failed to kill process ${child.pid}: ${error.message}`);
            }
        }
    }, 30000); // Giới hạn 30 giây
});

/**
 * Kiểm tra trạng thái tiến trình
 */
app.get('/api/terminal/status/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);

    try {
        process.kill(pid, 0); // Kiểm tra xem process có thực sự tồn tại không
        res.json({ status: "running", pid });
    } catch (error) {
        res.json({ status: "not found", pid });
    }
});

/**
 * Dừng tiến trình
 */
app.post('/api/terminal/kill/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);
    
    const killCommand = isWindows ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
    
    spawn(isWindows ? "cmd.exe" : "/bin/sh", [isWindows ? "/c" : "-c", killCommand]);

    res.json({ message: `Process ${pid} terminated` });
});

/**
 * Dừng tất cả tiến trình nền đang chạy
 */
app.post('/api/terminal/kill_all', (req, res) => {
    if (activeProcesses.size === 0) {
        logger.info("No processes to terminate.");
        return res.json({ message: "No running processes to terminate." });
    }

    let killedPids = [];
    activeProcesses.forEach((process, pid) => {
        try {
            process.kill();
            killedPids.push(pid);
            logger.info(`Killed process ${pid}`);
        } catch (error) {
            logger.error(`Failed to kill process ${pid}: ${error.message}`);
        }
    });

    activeProcesses.clear();
    res.json({ message: "All processes terminated", killedPids });
});

app.get('/api/terminal/processes', (req, res) => {
    if (activeProcesses.size === 0) {
        logger.info("No running processes to list");
        return res.json({ runningProcesses: [] });
    }

    const pids = Array.from(activeProcesses.keys()).join(",");
    spawn(`ps`, ["-p", pids, "-o", "pid,%cpu,%mem", "--no-headers"])
        .stdout.on('data', (data) => {
            const processList = data.toString().trim().split("\n").map(line => {
                const [pid, cpu, mem] = line.trim().split(/\s+/);
                return { pid: parseInt(pid), cpu, memory: mem };
            });
            res.json({ runningProcesses: processList });
        })
        .on('error', (error) => {
            logger.error(`Failed to fetch process info: ${error.message}`);
            return res.status(500).json({ error: error.message });
        });
});

// ========================== 🖥️ QUẢN LÝ ỨNG DỤNG GUI ==========================
const guiProcesses = new Map(); // Lưu danh sách ứng dụng GUI đang chạy
const MAX_GUI_PROCESSES = 5;

const cleanDeadGuiProcesses = () => {
    guiProcesses.forEach((process, pid) => {
        try {
            process.kill(0); // Kiểm tra xem process còn sống không
        } catch (error) {
            guiProcesses.delete(pid);
            logger.info(`Removed dead GUI process: ${pid}`);
        }
    });
};

app.post('/api/gui/start', (req, res) => {
    cleanDeadGuiProcesses();

    if (guiProcesses.size >= MAX_GUI_PROCESSES) {
        logger.warn("Too many GUI applications running");
        return res.status(429).json({ error: "Too many GUI applications running. Please close some first." });
    }

    const { appPath, args = [] } = req.body;
    if (!fs.existsSync(appPath)) {
        logger.warn(`Application not found: ${appPath}`);
        return res.status(404).json({ error: "Application not found" });
    }
    const command = process.env.DISPLAY ? appPath : `xvfb-run ${appPath}`;
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: true });

    child.unref();
    guiProcesses.set(child.pid, child);

    logger.info(`Started GUI application: ${appPath} (PID: ${child.pid})`);
    res.json({ message: "Application started", pid: child.pid });
});

const isProcessRunning = (pid) => {
    try {
        process.kill(pid, 0); // Kiểm tra xem PID có tồn tại không
        return true;
    } catch (error) {
        return false;
    }
};

app.get('/api/gui/status/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);
    const isRunning = isProcessRunning(pid);

    res.json({ pid, status: isRunning ? "running" : "not found" });
});

app.post('/api/gui/close/:pid', (req, res) => {
    const pid = parseInt(req.params.pid);
    const processToKill = guiProcesses.get(pid);

    if (processToKill) {
        try {
            processToKill.kill();
            guiProcesses.delete(pid);
            logger.info(`Closed GUI application (PID: ${pid})`);
            res.json({ message: `Application closed`, pid });
        } catch (error) {
            logger.error(`Failed to close application ${pid}: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    } else {
        logger.warn(`Application with PID ${pid} not found`);
        res.status(404).json({ error: "Application not found" });
    }
});

app.get('/api/gui/list', (req, res) => {
    const runningApps = Array.from(guiProcesses.keys());
    res.json({ running_apps: runningApps });
});

// Nhận diện UI bằng OpenCV
app.post('/api/gui/find_button', async (req, res) => {
    const { buttonImage } = req.body;
    try {
        const screen = await cv.imreadAsync('./screenshots/screenshot.png');
        const template = await cv.imreadAsync(buttonImage);

        const matched = screen.matchTemplate(template, 5); // Tìm hình ảnh
        const { maxLoc } = matched.minMaxLoc();

        if (maxLoc.x && maxLoc.y) {
            logger.info(`Button found at coordinates x: ${maxLoc.x}, y: ${maxLoc.y}`);
            res.json({ message: "Button found", x: maxLoc.x, y: maxLoc.y });
        } else {
            logger.warn("Button not found");
            res.status(404).json({ error: "Button not found" });
        }
    } catch (error) {
        logger.error(`Error finding button: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ========================== 🤖 HỖ TRỢ AI PHÂN TÍCH CODE & TÀI LIỆU 🤖 ==========================
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/code/analyze', async (req, res) => {
    const { code } = req.body;

    if (!process.env.OPENAI_API_KEY) {
        logger.error("OPENAI_API_KEY is not configured.  Code analysis is disabled.");
        return res.status(500).json({error: "OPENAI_API_KEY is not configured."});
    }
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "system", content: "Analyze this code and provide improvements." }, { role: "user", content: code }],
        });

        logger.info("Code analysis completed successfully");
        res.json({ analysis: response.choices[0].message.content });
    } catch (error) {
        logger.error(`Code analysis failed: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ========================== 🎮 ĐIỀU KHIỂN GUI TỰ ĐỘNG (AUTO GUI AUTOMATION) ==========================
const robot = require("robotjs");
const screenshot = require("screenshot-desktop");
const Tesseract = require("tesseract.js");

// Di chuyển chuột
const performMouseMove = (x, y, socket) => {
    try {
        robot.moveMouse(x, y);
        logger.info(`Mouse moved to coordinates x: ${x}, y: ${y}`);
        socket.emit('mouse_moved', { x, y });
    } catch (error) {
        logger.error(`Mouse move failed: ${error.message}`);
        socket.emit('gui_error', { error: error.message });
    }
};

// Click chuột
const performMouseClick = (socket) => {
    try {
        robot.mouseClick();
        logger.info('Mouse clicked');
        socket.emit('mouse_clicked');
    } catch (error) {
        logger.error(`Mouse click failed: ${error.message}`);
        socket.emit('gui_error', { error: error.message });
    }
};

// Gõ phím
const performKeyboardType = (text, socket) => {
    try {
        robot.typeString(text);
        logger.info(`Text typed: ${text}`);
        socket.emit('text_typed', { text });
    } catch (error) {
        logger.error(`Keyboard type failed: ${error.message}`);
        socket.emit('gui_error', { error: error.message });
    }
};
io.on('connection', async (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Gửi dữ liệu công việc đang thực hiện khi có client kết nối lại
    try {
        const tasks = await getTaskFromRedis();
        socket.emit('sync_tasks', { message: "Tasks synchronized", tasks });
        logger.info(`Sent task sync data to client ${socket.id}`);
    } catch (error) {
        logger.error(`Error syncing tasks to client ${socket.id}: ${error.message}`);
    }
    // Di chuyển chuột
    socket.on('mouse_move', (data) => {
        const { x, y } = data;
        performMouseMove(x, y, socket);
    });

    // Click chuột
    socket.on('mouse_click', () => {
        performMouseClick(socket);
    });

    // Gõ phím
    socket.on('keyboard_type', (data) => {
        performKeyboardType(data.text, socket);
    });
    socket.on('execute_command_ws', (data) => {
        const { command } = data;
        logger.info(`Executing command via WebSocket: ${command}`);

        const child = spawn(command, { shell: true });

        activeProcesses.set(child.pid, child);

        child.stdout.on('data', (output) => {
            socket.emit('command_output', { output: output.toString() });
        });

        child.stderr.on('data', (error) => {
            socket.emit('command_error', { error: error.toString() });
        });

        child.on('close', (code) => {
            logger.info(`Command completed with exit code ${code}`);
            socket.emit('command_complete', { status: `Exited with code ${code}` });
            activeProcesses.delete(child.pid);
        });

        // Xử lý khi client mất kết nối
        socket.on('disconnect', () => {
            if (activeProcesses.has(child.pid)) {
                try {
                    child.kill();
                    logger.warn(`Client ${socket.id} disconnected, killed process ${child.pid}`);
                    socket.emit('command_terminated', { pid: child.pid, reason: "Client disconnected" });
                } catch (error) {
                    logger.error(`Failed to kill process ${child.pid} due to client disconnect: ${error.message}`);
                }
                activeProcesses.delete(child.pid);
            }
        });
    });

    // Xử lý sự kiện upload file
    socket.on('upload_file', async (data) => {
        try {
            const { filename, content } = data;

            if (content.length > MAX_FILE_SIZE) {
                logger.warn(`Upload file ${filename} exceeds limit (50MB)`);
                return socket.emit('upload_error', { error: 'File size exceeds limit (50MB)' });
            }

            const filePath = path.join(__dirname, 'uploads', filename);

            await fsPromises.writeFile(filePath, content); // Sử dụng fsPromises.writeFile
            logger.info(`File uploaded via WebSocket: ${filename}`);
            socket.emit('upload_complete', { filename });
        } catch (error) {
            logger.error('File upload error:', error);
            socket.emit('upload_error', { error: error.message });
        }
    });

    // Xử lý sự kiện giám sát hệ thống
    socket.on('monitor_system', async () => {
        try {
            const systemInfo = await getSystemInfo();
            socket.emit('system_info', systemInfo);
        } catch (error) {
            logger.error('System monitoring error:', error);
            socket.emit('monitor_error', { error: error.message });
        }
    });

    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
    });
});
const saveTaskToRedis = async (taskId, taskData) => {
    try {
        await redis.set(`task:${taskId}`, JSON.stringify(taskData));
        logger.info(`Task saved to Redis. TaskId: ${taskId}`);
    } catch (error) {
        logger.error(`Error saving task to Redis: ${error.message}`);
        throw error;
    }
};

// Hàm lấy thông tin công việc từ Redis
const getTaskFromRedis = async (taskId) => {
    try {
        const task = await redis.get(`task:${taskId}`);
        if (task) {
            logger.info(`Task retrieved from Redis. TaskId: ${taskId}`);
            return JSON.parse(task);
        }
        logger.warn(`Task not found in Redis. TaskId: ${taskId}`);
        return null;
    } catch (error) {
        logger.error(`Error retrieving task from Redis: ${error.message}`);
        throw error;
    }
};

// Hàm xóa thông tin công việc từ Redis
const deleteTaskFromRedis = async (taskId) => {
    try {
        await redis.del(`task:${taskId}`);
        logger.info(`Task deleted from Redis. TaskId: ${taskId}`);
    } catch (error) {
        logger.error(`Error deleting task from Redis: ${error.message}`);
        throw error;
    }
};

// Lưu lịch sử công việc vào Redis
async function saveTaskHistory(taskId, taskData) {
    await redis.set(`history:${taskId}`, JSON.stringify(taskData));
}

// API lấy toàn bộ lịch sử công việc
app.get('/api/tasks/history', async (req, res) => {
    try {
        const keys = await redis.keys('history:*');
        const history = {};

        for (const key of keys) {
            const taskId = key.split(':')[1];
            history[taskId] = JSON.parse(await redis.get(key));
        }

        logger.info("Retrieved all task history successfully.");
        res.json({ history });
    } catch (error) {
        logger.error(`Error retrieving task history: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API lấy toàn bộ lịch sử công việc
app.get('/api/tasks/history', async (req, res) => {
    try {
        const keys = await redis.keys('history:*');
        const history = {};

        for (const key of keys) {
            const taskId = key.split(':')[1];
            history[taskId] = JSON.parse(await redis.get(key));
        }

        res.json({ history });
    } catch (error) {
        logger.error(`Error retrieving task history: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ========================== 🔥 KHỞI ĐỘNG SERVER & NGROK 🔥 ==========================

const tasksFile = path.join(__dirname, 'tasks.json');

// API lưu trạng thái công việc
app.post('/api/tasks/save', async (req, res) => {
    const { taskId, description, status, progress } = req.body;
    try {
        const taskData = { description, status, progress, updatedAt: new Date() };

        await saveTaskToRedis(taskId, taskData);
        logger.info(`Task saved successfully. TaskId: ${taskId}`);
        res.json({ message: "Task saved successfully", task: taskData });
    } catch (error) {
        logger.error(`Error saving task: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API lấy trạng thái công việc
app.get('/api/tasks/get/:taskId', async (req, res) => {
    const { taskId } = req.params;
    try {
        const task = await getTaskFromRedis(taskId);
        if (!task) {
            logger.warn(`Task not found: ${taskId}`);
            return res.status(404).json({ error: "Task not found" });
        }
        logger.info(`Task retrieved successfully. TaskId: ${taskId}`);
        res.json({ task });
    } catch (error) {
        logger.error(`Error retrieving task: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API xóa công việc khi hoàn thành
app.delete('/api/tasks/delete/:taskId', async (req, res) => {
    const { taskId } = req.params;
    const task = await redis.get(`task:${taskId}`);

    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    await redis.set(`history:${taskId}`, task);
    await redis.del(`task:${taskId}`);

    logger.info(`Task archived and deleted successfully. TaskId: ${taskId}`);
    res.json({ message: "Task archived and deleted successfully" });
});

// API lấy lịch sử công việc đã hoàn thành
app.get('/api/tasks/history/:taskId', async (req, res) => {
    const { taskId } = req.params;
    const task = await redis.get(`history:${taskId}`);

    if (task) {
        logger.info(`Task history retrieved successfully. TaskId: ${taskId}`);
        res.json({ task: JSON.parse(task) });
    } else {
        logger.warn(`No history found for this task: ${taskId}`);
        res.status(404).json({ error: "No history found for this task" });
    }
});

app.post('/api/tasks/update', async (req, res) => {
    const { taskId, progress } = req.body;

    try {
        const task = await getTaskFromRedis(taskId);
        if (!task) {
            logger.warn(`Task not found: ${taskId}`);
            return res.status(404).json({ error: "Task not found" });
        }

        task.progress = progress;
        task.updatedAt = new Date();
        await saveTaskToRedis(taskId, task);
        logger.info(`Task updated successfully. TaskId: ${taskId}, Progress: ${progress}`);

        res.json({ message: "Task updated successfully", task });
    } catch (error) {
        logger.error(`Error updating task: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});
// API Đồng Bộ Trạng Thái Công Việc Khi Kết Nối Lại
// API Kiểm Tra Trạng Thái Công Việc
app.get('/api/tasks/sync', async (req, res) => {
    try {
        const taskKeys = await redis.keys('task:*');
        const tasks = {};

        for (const key of taskKeys) {
            const taskId = key.split(':')[1];
            const task = await getTaskFromRedis(taskId);
            if (task) {
                tasks[taskId] = task;
            }
        }
        logger.info("Tasks synchronized");
        res.json({ message: "Tasks synchronized", tasks });
    } catch (error) {
        logger.error(`Error syncing tasks: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});
//Playwright API
const browsers = new Map();

app.post('/api/browser/open', async (req, res) => {
    const { url } = req.body;
    try {
        const browser = await chromium.launch({
            headless: !isWindows // Windows có thể không cần headless
        });
        const page = await browser.newPage();
        await page.goto(url);

        const browserId = Date.now().toString();
        browsers.set(browserId, browser);

        logger.info(`Opened ${url} with Playwright`);
        res.json({ message: `Opened ${url}`, browserId });
    } catch (error) {
        logger.error(`Playwright failed to open browser: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/browser/close', async (req, res) => {
    const { browserId } = req.body;
    if (browsers.has(browserId)) {
        await browsers.get(browserId).close();
        browsers.delete(browserId);
        res.json({ message: "Browser closed" });
    } else {
        res.status(404).json({ error: "Browser not found" });
    }
});
async function startNgrok() {
    try {
        await ngrok.kill();
        await ngrok.authtoken("2sSSODOIlfxwnA6dMb18J3vKmIO_7pp7aKtnAmZR2WrnswYiv");

        const url = await ngrok.connect({
            proto: "http",
            addr: 80,
            hostname: "bobcat-select-strangely.ngrok-free.app",
            region: "us"
        });

        logger.info(`✅ Ngrok connected: ${url}`);
        console.log(`🚀 Ngrok URL: ${url}`);

        return url;
    } catch (error) {
        logger.error("⚠️ Ngrok connection error:", error);
        return null;
    }
}

async function startServer() {
    try {
        await new Promise((resolve) => {
            server.listen(PORT, () => {
                logger.info(`✅ Server running on port ${PORT}`);
                resolve();
            });
        });

        // Khởi động Ngrok sau khi server chạy
        if (isWindows) {
            logger.info("🖥️ Running on Windows, starting Ngrok...");
            await startNgrok();
        }

    } catch (error) {
        logger.error("❌ Server startup error:", error);
        process.exit(1);
    }
}

startServer();