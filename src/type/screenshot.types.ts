export interface IPostScreenshotResponse {
  file_name: string;
  success: boolean;
  buffer?: Buffer;
}

export interface IPostCapture {
    buffer: Buffer;
    success: boolean;
}