import axios from "axios";
import axiosRetry from "axios-retry";
import https from "https";
import { SETTINGS } from "../config";
import { log } from "../utils";

const agent = new https.Agent({ rejectUnauthorized: false });

const blogixApi = axios.create({
  baseURL: SETTINGS.BLOGIX_API_URL,
  headers: { "Content-Type": "application/json", "X-Api-Key": SETTINGS.BLOGIX_API_KEY},
  timeout: 30000,
  httpsAgent: process.env.USE_INSECURE_TLS === "true" ? agent : undefined,
});

// Retry при 502/503/сетевых ошибках (3 попытки, экспоненциальная задержка)
axiosRetry(blogixApi, {
  retries: 3,
  retryDelay: () => 1000,
  retryCondition: (error) => {
    const status = error.response?.status;
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || status === 502 || status === 503;
  },
  onRetry: (count, error) => {
    log.warn(`⚠️ Blogix API retry ${count}/3: ${error.response?.status || error.message}`);
  },
});


export const getUploadLink = async (signal?: AbortSignal): Promise<{file_name: string, url: string}> => {
  try {
    const CONTENT_TYPE = 2;
    const response = await blogixApi.get(`/file/v/upload_link`, { 
      params: { extension: "png", content_type: CONTENT_TYPE },
      signal: signal
    });
    return response?.data;
  } catch (error: any) {
    if (axios.isCancel(error)) throw new Error("ABORTED_BY_CLIENT");
    
    if (error.code === "ECONNABORTED") {
      log.error(`❌ Blogix API Timeout: link request took more than 30s`);
      throw new Error("UPLOAD_LINK_TIMEOUT");
    }
    
    const details = error.response?.data?.message || error.message;
    log.error(`❌ Blogix API Fail: ${details}`);
    throw new Error(`UPLOAD_LINK_FAILED: ${details}`);
  }
};