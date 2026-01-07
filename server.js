const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// DeepSeek Configuration
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

// Vision Model Configuration
const VISION_API_KEY = process.env.VISION_API_KEY;
const VISION_API_URL = process.env.VISION_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const VISION_MODEL_NAME = process.env.VISION_MODEL_NAME || 'qwen-vl-max';

// File Upload Endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl, type: req.file.mimetype, originalName: req.file.originalname });
});

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;

        if (!messages) {
            return res.status(400).json({ error: 'Messages are required' });
        }

        // 1. Check if the conversation contains images
        let hasImages = false;
        messages.forEach(msg => {
            if (Array.isArray(msg.content)) {
                msg.content.forEach(item => {
                    if (item.type === 'image_url') hasImages = true;
                });
            }
        });

        // 2. Determine which model to use
        let targetApiKey = DEEPSEEK_API_KEY;
        let targetApiUrl = DEEPSEEK_API_URL;
        let targetModel = 'deepseek-chat';

        if (hasImages) {
            console.log('🖼️ Image detected, switching to Vision Model...');
            if (!VISION_API_KEY || VISION_API_KEY.includes('your_')) {
                 console.warn('⚠️ No Vision API Key found. Falling back to text description.');
                 hasImages = false; 
            } else {
                targetApiKey = VISION_API_KEY;
                targetApiUrl = VISION_API_URL;
                targetModel = VISION_MODEL_NAME;
            }
        }

        // 3. Process Messages (Handle Local Images -> Base64)
        const processedMessages = await Promise.all(messages.map(async (msg) => {
            if (Array.isArray(msg.content)) {
                // Deep copy content to avoid mutating original
                const newContent = await Promise.all(msg.content.map(async (item) => {
                    
                    // Handle Image
                    if (item.type === 'image_url') {
                        // If we are falling back to text-only model
                        if (!hasImages) {
                             return { type: 'text', text: `[用户上传图片: ${item.image_url.url}]` };
                        }

                        // If using Vision Model, we need to ensure the URL is accessible
                        const imgUrl = item.image_url.url;
                        if (imgUrl.startsWith('/uploads/')) {
                            try {
                                const filePath = path.join(__dirname, 'public', imgUrl);
                                if (fs.existsSync(filePath)) {
                                    const imageBuffer = fs.readFileSync(filePath);
                                    const base64Image = imageBuffer.toString('base64');
                                    const ext = path.extname(filePath).toLowerCase().replace('.', '');
                                    const mimeType = ext === 'jpg' ? 'jpeg' : ext; // fix jpg mime
                                    
                                    return {
                                        type: 'image_url',
                                        image_url: {
                                            url: `data:image/${mimeType};base64,${base64Image}`
                                        }
                                    };
                                }
                            } catch (e) {
                                console.error('Error reading image:', e);
                                return { type: 'text', text: `[Image Read Error]` };
                            }
                        }
                    }

                    // Handle Video (Still no standard API for video, convert to text)
                    if (item.type === 'video_url') {
                        return { type: 'text', text: `[用户上传视频: ${item.video_url.url}]` };
                    }

                    return item;
                }));
                
                return { role: msg.role, content: newContent };
            }
            return msg;
        }));

        console.log(`🚀 Sending request to: ${targetModel}`);

        // 4. Send Request
        const response = await axios({
            method: 'post',
            url: targetApiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${targetApiKey}`
            },
            data: {
                model: targetModel,
                messages: processedMessages,
                stream: true
            },
            responseType: 'stream'
        });

        // 5. Stream Response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        response.data.pipe(res);

    } catch (error) {
        console.error('API Call Error:', error.message);
        if (error.response) {
            console.error('Response Data:', error.response.data);
            res.status(error.response.status).json({ error: error.response.data });
        } else {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
