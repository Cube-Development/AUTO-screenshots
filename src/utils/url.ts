import { ResourceType } from "../type";

export function determineResourceType(url: string): ResourceType {
    if (!url) return ResourceType.UNKNOWN;

    switch (true) {
        case /^https:\/\/(www\.)?youtube\.com\/watch|^https:\/\/youtu\.be\//.test(url):
            return ResourceType.YOUTUBE;
        case /^https:\/\/t\.me\//.test(url):
            return ResourceType.TELEGRAM;
        case /^https:\/\/www\.instagram\.com\//.test(url):
            return ResourceType.INSTAGRAM;
        default:
            return ResourceType.UNKNOWN;
    }
}
