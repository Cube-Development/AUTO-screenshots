import 'dotenv/config';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { SETTINGS } from '../../config';
import { log } from '../../utils';

// const API_URL = 'http://128.140.45.216:3000/screenshot/post';
const API_URL = 'http://localhost:80/screenshot/post';
const TEST_URLS = [
    // 'https://www.instagram.com/p/DU4QYqpgnpX/',
    // "https://www.instagram.com/reels/DUL3wNVCDte/",
    // "https://www.instagram.com/reel/DQHfm-FiNrG/?igsh=c2ZpNG4wYXU0a3dx",
    // "https://www.instagram.com/p/DUVj4Y3jcFL/",
    // "https://www.youtube.com/watch?v=ifr2-iQ0owY&t=200s",
    // "https://www.youtube.com/watch?v=ifr2-iQ0owY&t=1200s",
    "https://www.youtube.com/watch?v=zTPTBM4boXc&t=200s",
    "https://www.youtube.com/watch?v=zTPTBM4boXc&t=1200s",
    // "https://www.youtube.com/watch?v=89l5VdZps5E&t=3600s",
    // "https://www.youtube.com/watch?v=89l5VdZps5E&t=7200s",
    // "https://www.youtube.com/watch?v=N2m4RFhCqKg&t=200s",
    // "https://www.youtube.com/watch?v=N2m4RFhCqKg&t=1200s",
    // "https://www.youtube.com/watch?v=SpknDrVyOgg&t=200s",
    // "https://www.youtube.com/watch?v=SpknDrVyOgg&t=1200s",
    // "https://www.youtube.com/watch?v=SpknDrVyOgg&t=2400s",
    // "https://www.youtube.com/watch?v=SpknDrVyOgg&t=3600s",
    // "https://t.me/uzbekfintech/3254",
    // "https://t.me/if_market_news/80201",
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
    // "https://t.me/devsp/5540",
    // "https://t.me/devsp/5541",
    // "https://t.me/devsp/5542",
    "https://t.me/devsp/5543",
    "https://t.me/devsp/5544",
    "https://t.me/uzbekfintech/3470",
    // "https://t.me/uzbekfintech/3471",
    // "https://t.me/uzbekfintech/3472",
    // "https://t.me/uzbekfintech/3473",
    // "https://t.me/uzbekfintech/3474",
    // "https://t.me/ru2ch/167316",
    // "https://t.me/ru2ch/167317",
    // "https://t.me/ru2ch/167318",
    // "https://t.me/ru2ch/167319",
    // "https://t.me/ru2ch/167320",
    // "https://t.me/abuwtf/35610",
    // "https://t.me/abuwtf/35611",
    // "https://t.me/abuwtf/35612",
    "https://t.me/abuwtf/35613",
    // "https://t.me/abuwtf/35614",
    // "https://t.me/if_market_news/80220",
]

const NUM_CONCURRENT_REQUESTS = 1;

// Настройка ретраев для обхода Rate Limiter (5 RPS)
axiosRetry(axios, { 
    retries: 10, 
    retryDelay: (retryCount, error) => {
        const delay = Math.floor(Math.random() * 2000) + 1000;
        log.info(`[Retry] Попытка ${retryCount} для запроса | ${error?.config?.data} | Delay: ${delay}`);
        return delay; // фиксированная задержка 1с (соответствует windowMs лимитера)
    },
    retryCondition: (error) => {
        // Ретрай при любых ошибках сервера (400, 429, 500+) ИЛИ при сетевых ошибках без ответа
        // (400 возвращается контроллером post-screenshot.controller.ts при внутренних ошибках сервиса)
        const status = error.response?.status;
        return (status !== undefined && (status >= 400 && status !== 422)) || !error.response;
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
        log.info(`[Req ${id}] ✅ SUCCESS | Time: ${duration / 1000}s | File: ${response.data.file_name}`);
    } catch (error: any) {
        const duration = Date.now() - start;
        const errorMsg = error.response?.data?.message || error.message;
        log.error(`[Req ${id}] ❌ FAILED | Time: ${duration / 1000}s | Error: ${errorMsg}`);
    }
}

async function runScreenshotStressTest() {
    log.info(`🔥 Starting Stress Test: ${NUM_CONCURRENT_REQUESTS} parallel requests...`);
    
    const tasks = Array.from({ length: NUM_CONCURRENT_REQUESTS }, (_, i) => sendScreenshotRequest(i + 1));
    
    const startOverall = Date.now();
    await Promise.all(tasks);
    const totalDuration = Date.now() - startOverall;

    function msToTimeString(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        return `${minutes}min ${seconds.toString().padStart(2, '0')}sec`;
    }    
    log.info(`\n🏁 Test Finished in ${totalDuration / 1000}s | ${msToTimeString(totalDuration)}`);
}

runScreenshotStressTest();
