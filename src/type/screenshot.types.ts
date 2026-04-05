export interface IPostScreenshotResponse {
  file_name: string;
  success: boolean;
  buffer?: Buffer;
}

export interface IPostCapture {
    buffer: Buffer;
    success: boolean;
}

export interface IYoutubeDebugResponse {
    success: boolean;
    type: 'youtube_debug';
    total: number;
}

export enum ResourceType {
  YOUTUBE = 'YT',
  TELEGRAM = 'TG',
  INSTAGRAM = 'IG',
  UNKNOWN = 'unknown'
}