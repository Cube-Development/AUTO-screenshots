import 'dotenv/config';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { SETTINGS } from '../../config';
import { log } from '../../utils';

const API_URL = 'http://localhost:80/screenshot/post';
const TEST_URLS = [
    // 'https://www.instagram.com/p/DU4QYqpgnpX/',
    // "https://www.instagram.com/reels/DUL3wNVCDte/",
    // "https://www.instagram.com/reel/DQHfm-FiNrG/?igsh=c2ZpNG4wYXU0a3dx",
    // "https://www.instagram.com/p/DUVj4Y3jcFL/",
    // "https://t.me/uzbekfintech/3254",
    "https://t.me/if_market_news/80201",
    // "https://t.me/if_market_news/80202",
    // "https://t.me/if_market_news/80203",
    // "https://t.me/if_market_news/80204",
    // "https://t.me/if_market_news/80205",
    // "https://t.me/if_market_news/80206",
    // "https://t.me/if_market_news/80207",
    // "https://t.me/if_market_news/80208",
    // "https://t.me/if_market_news/80209",
    // "https://t.me/if_market_news/80210",
    // "https://t.me/if_market_news/80211",
    // "https://t.me/if_market_news/80212",
    // "https://t.me/if_market_news/80213",
    // "https://t.me/if_market_news/80214",
    // "https://t.me/if_market_news/80215",
    // "https://t.me/if_market_news/80216",
    // "https://t.me/if_market_news/80217",
    // "https://t.me/if_market_news/80218",
    // "https://t.me/if_market_news/80219",
    // "https://t.me/if_market_news/80220",
]

const NUM_CONCURRENT_REQUESTS = 1;

// Настройка ретраев для обхода Rate Limiter (5 RPS)
axiosRetry(axios, { 
    retries: 5, 
    retryDelay: (retryCount) => {
        log.info(`[Retry] Попытка ${retryCount} для запроса...`);
        return 1000; // фиксированная задержка 1с (соответствует windowMs лимитера)
    },
    retryCondition: (error) => {
        return error.response?.status === 429;
    },
    shouldResetTimeout: true // Сбрасываем таймаут axios при каждой попытке
});

async function sendScreenshotRequest(id: number) {
    const url = TEST_URLS[id % TEST_URLS.length];
    const start = Date.now();
    
    log.info(`[Req ${id}] 🚀 Отправлен запрос: ${url}`);
    
    try {
        const response = await axios.post(API_URL, {
            post_url: url,
            user_bot_id: "7487149368"
        }, {
            headers: {
                'X-API-Key': SETTINGS.SERVER_API_KEY
            },
            timeout: 180000 // Увеличиваем до 180с, так как ретраи занимают время
        });
        const duration = Date.now() - start;
        log.info(`[Req ${id}] ✅ SUCCESS | Time: ${duration}ms | File: ${response.data.file_name}`);
    } catch (error: any) {
        const duration = Date.now() - start;
        const errorMsg = error.response?.data?.message || error.message;
        log.error(`[Req ${id}] ❌ FAILED | Time: ${duration}ms | Error: ${errorMsg}`);
    }
}

async function runScreenshotStressTest() {
    log.info(`🔥 Starting Stress Test: ${NUM_CONCURRENT_REQUESTS} parallel requests...`);
    
    const tasks = Array.from({ length: NUM_CONCURRENT_REQUESTS }, (_, i) => sendScreenshotRequest(i + 1));
    
    const startOverall = Date.now();
    await Promise.all(tasks);
    const totalDuration = Date.now() - startOverall;
    
    log.info(`\n🏁 Test Finished in ${totalDuration}ms`);
}

runScreenshotStressTest();
