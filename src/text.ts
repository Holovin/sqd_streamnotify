import { Channels, EventType, OnlineStream, photoEventMap, PlatformType } from './types.js';
import { Streamers, config } from './config.js';

const platformInfo = {
    [PlatformType.TWITCH]: {
        emoji: '🔴',
        label: 'Twitch',
    },
}

export function getStatus(title: string, stream: OnlineStream, isOnline: boolean): string {
    const duration = stream.duration.startsWith('00:0') ? '' : `for _${stream.duration}_ `;
    const streamName = getChannelDisplayName(config.streamers.twitch.streamers, stream.name);
    const streamUrl = getStreamMarkdownLink(stream, `[Open stream on ${platformInfo[stream.platform].label} ↗]`);

    return `${streamName} ${isOnline ? 'is' : 'was'} live ` +
        `${duration}${isOnline ? platformInfo[stream.platform].emoji : '⚪️'}\n` +
        `${title}\n\n` +
        streamUrl;
}

export function getShortStatus(streams: OnlineStream[]): string {
    let message = ``;

    if (!streams.length) {
        message += `⚪ Everybody is offline`;
        return message;
    }

    const isSomeTwitch = streams.some(stream => stream.platform === PlatformType.TWITCH);
    if (isSomeTwitch) {
        message += platformInfo[PlatformType.TWITCH].emoji;
    }

    message += ` ${streams.length} online`;

    streams.forEach(stream => {
        message += `\n· ${getStreamMarkdownLink(stream)} *${stream.title}*`;
    });

    return message;
}

export function getChannelPhoto(streamers: Streamers, onlineStream: OnlineStream|null, eventType: EventType): string {
    if (onlineStream) {
        const platform = streamers.twitch;

        const streamerName = onlineStream.name.toLowerCase().replace('\\', '');
        return platform.streamers[streamerName]?.[photoEventMap[eventType]] ?? streamers.defaultChannelValues[photoEventMap[eventType]];
    }

    return streamers.defaultChannelValues[photoEventMap[eventType]];
}

export function getChannelDisplayName(channels: Channels, user: string) {
    return channels[user]?.displayName ?? user;
}

export function getStreamLink(stream: OnlineStream): string {
    const baseDomain = stream.platform === PlatformType.TWITCH ? 'https://twitch.tv' : '';
    return `${baseDomain}/${stream.name}`;
}

function getStreamMarkdownLink(stream: OnlineStream, text = ''): string {
    return `[${text === '' ? stream.name : text}](${getStreamLink(stream)})`;
}
