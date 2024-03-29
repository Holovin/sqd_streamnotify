import axios from 'axios';
import { escapeMarkdown, getArrDiff, sleep } from './helpers.js';
import { EventType, Notification, OnlineStream } from './types.js';
import { logger } from './logger.js';
import { Database } from './db.js';
import { Twitch } from './twitch.js';
import { Telegram } from './telegram.js';
import { formatRecordings, getChannelDisplayName, getChannelPhoto, getShortStatus, getStreamLink } from './text.js';
import { config } from './config.js';
import { postProcess } from './streamProcessor.js';
import { Recorder } from './recorder.js';

logger.info(`== SQD StreamNotify config ==` +
    `\nStarted, settings:\n` +
    `- channels Twitch: ${JSON.stringify(config.streamers.twitch.streamerNames)}\n` +
    `- chatId: ${config.tg.chatId}\n` +
    `- adminId: ${config.tg.adminId}\n` +
    `- timeout: ${config.timeout}\n` +
    `- heartbeat: ${config.heatbeatUrl}\n`
);

class App {
    private state: OnlineStream[] = [];
    private db: Database;
    private twitch: Twitch;
    private bot: Telegram;
    private recorder: Recorder;
    private lastRecorderNotification: Date = new Date(0);

    public constructor() {
        this.db = new Database();
        this.twitch = new Twitch(config.twitch.id, config.twitch.secret);
        this.bot = new Telegram(config.tg.token);
        this.recorder = new Recorder();
    }

    public async main() {
        await this.init();

        this.bot.start().then(() => {
            logger.warn('Bot died somehow...');
        });

        while (true) {
            if (config.heatbeatUrl) {
                logger.debug( `tick: heartbeat...`);
                await axios.get(config.heatbeatUrl);
            }

            logger.debug( `tick: checkOnline, (${new Date()}), state: ${this.state.length}`);
            const online = await this.taskCheckOnline();

            logger.debug( `tick: stateProcess, (${new Date()}), state: ${this.state.length} `);
            this.state = await this.stateHandler(this.state, online);

            logger.debug( `tick: checkBansTwitch, (${new Date()}), state: ${this.state.length}`);
            await this.taskCheckBansTwitch();

            if (this.recorder.getActiveRecordings().length > 0) {
                logger.debug( `tick: checkDiskState, (${new Date()})`);
                const notifications = await this.checkDiskState();
                if (notifications.length > 0) {
                    await this.bot.sendNotifications(config.tg.adminId, notifications);
                }
            }

            logger.debug( `tick: loop done, (${new Date()})`);
            await sleep(config.timeout);
        }
    }

    private async taskCheckOnline(): Promise<OnlineStream[]> {
        const out: OnlineStream[] = [];

        if (config.streamers.twitch.streamerNames.length > 0) {
            out.push(...(await this.twitch.pullTwitchStreamers(config.streamers.twitch.streamerNames)));
        }

        return out;
    }

    private async taskCheckBansTwitch(): Promise<void> {
        const usersSaved: string[] = JSON.parse(await this.db.get(Database.DB_USERS));
        const usersFresh = await this.twitch.pullTwitchAliveUsers(config.streamers.twitch.streamerNames);
        if (!usersFresh) {
            logger.warn(`checkBans: no answer from API, skip`);
            return;
        }

        const usersFreshFlat = usersFresh.map(user => user.name);
        const banned = getArrDiff<string>(usersSaved, usersFreshFlat);
        const unbanned = getArrDiff<string>(usersFreshFlat, usersSaved);

        const notifications: Notification[] = [];

        logger.debug(`checkBans: banned -- ${JSON.stringify(banned)}`);
        logger.debug(`checkBans: unbanned -- ${JSON.stringify(unbanned)}`);

        banned.forEach(user => {
            notifications.push({
                message: `*${getChannelDisplayName(config.streamers.twitch.streamers, Twitch.normalizeStreamerLogin(user), user)}* is banned\\!`,
                photo: getChannelPhoto(config.streamers, null, EventType.banned),
                trigger: 'banned (new)',
            });
        });

        unbanned.forEach(user => {
            notifications.push({
                message: `*${getChannelDisplayName(config.streamers.twitch.streamers, Twitch.normalizeStreamerLogin(user), user)}* is unbanned\\!`,
                photo: getChannelPhoto(config.streamers, null, EventType.unbanned),
                trigger: 'unbanned (new)',
            });
        });

        await this.bot.sendNotifications(config.tg.chatId, notifications);
        if (banned.length > 0 || unbanned.length > 0) {
            await this.db.set(Database.DB_USERS, JSON.stringify(usersFreshFlat));
            logger.info(`checkBans: update DB done`);
        }
    }

    private async init() {
        const callbackGetPin = async (key: string, value: string) => {
            logger.info(`get_pin [callback]: reset current state`);
            this.state = [];
            return this.db.set(key, value);
        };

        const callbackGetRe = async () => {
            logger.info(`get_re [callback]`);

            const state = await Recorder.getFreeSpace();
            return [`*Disk space*` + escapeMarkdown(`: ${state.freeAvailableG}`), this.recorder.getActiveRecordings()];
        }

        await this.db.init(config.streamers.twitch.streamerNames);
        await this.bot.initBot(callbackGetPin, callbackGetRe);
    }

    private async stateHandler(state, online) {
        const data = postProcess(state, online);

        if (data.notifications.length > 0) {
            await this.bot.sendNotifications(config.tg.chatId, data.notifications);

            const msgID = await this.db.get(Database.getChatIdKey(config.tg.chatId));
            if (msgID) {
                const isDone = await this.bot.updatePin(config.tg.chatId, msgID, getShortStatus(online));
                if (!isDone) {
                    await this.db.delete(Database.getChatIdKey(config.tg.chatId));
                    logger.info(`checkOnline: chatID = ${config.tg.chatId} removed from DB`);
                }
            }
        }

        if (data.toStopRecord.length > 0) {
            const notifications: Notification[] = [];
            logger.info(`stateProcess: stop queue -- ${data.toStopRecord.length}`);

            for (const rec of data.toStopRecord) {
                this.recorder.stopByUrl(rec.loginNormalized);
                notifications.push({
                    message: `🕵️ *Stop recording* ` + escapeMarkdown(`-- ${rec.loginNormalized}`),
                    trigger: 'recorder+stop',
                });
            }

            await this.bot.sendNotifications(config.tg.adminId, notifications);
        }

        if (data.toStartRecord.length > 0) {
            const notifications: Notification[] = [];
            logger.info(`stateProcess: start queue -- ${data.toStartRecord.length}`);

            for (const rec of data.toStartRecord) {
                await this.recorder.add(getStreamLink(rec), rec.loginNormalized);
                notifications.push({
                    message: `🕵️ *Start recording* ` + escapeMarkdown(`-- ${rec.loginNormalized}`),
                    trigger: 'recorder+add'
                });
            }

            await this.bot.sendNotifications(config.tg.adminId, notifications);
        }

        return data.state;
    }

    private async checkDiskState(): Promise<Notification[]> {
        const freeSpace = await Recorder.getFreeSpace();
        if (!freeSpace) {
            logger.error(`checkDiskState: no response!`);
            return [{
                message: `🧯 *checkDiskState error\\!*`,
                trigger: `checkDiskState ERR`,
            }];
        }

        const messageRecordings = formatRecordings(this.recorder.getActiveRecordings());
        const diff = Date.now() - this.lastRecorderNotification;
        const HOUR_QUARTER = 60 * 15 * 1000;
        if (diff > HOUR_QUARTER && freeSpace.freeAvailableG < 7) {
            this.updateLastRN();
            return [{
                message: `🧯 *LOW DISK SPACE (<7)*`
                    + escapeMarkdown(`: ${freeSpace.freeAvailableG}`)
                    + `\n\n${messageRecordings}`,
                trigger: `checkDiskState <7`
            }];
        }

        const HOUR = 60 * 60 * 1000;
        if (diff > HOUR) {
            this.updateLastRN();
            return [{
                message: `💁 *Disk space state*`
                    + escapeMarkdown(`: ${freeSpace.freeAvailableG}`)
                    + `\n\n${messageRecordings}`,
                trigger: `checkDiskState OK`,
            }];
        }

        return [];
    }

    private updateLastRN() {
        this.lastRecorderNotification = new Date();
    }
}

try {
    const app = new App();
    app
        .main()
        .then(() => {});

} catch (e: unknown) {
    logger.info(JSON.stringify(e));

    if (e instanceof Error) {
        logger.error(`GGWP: ${e.message}`);
    }
}
