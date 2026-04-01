export interface IPostScreenshotResponse {
  file_name: string;
  success: boolean;
}

export interface IPostCapture {
    buffer: Buffer;
    success: boolean;
}