import { GrammyError } from 'grammy';
import { Bot } from 'grammy';
import { Notification } from './types.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { escapeMarkdown, sleep } from './helpers.js';
import { Database } from './db.js';
import { StreamRecord } from './recorder.js';
import { format } from 'date-fns/format';
import { formatRecordings } from './text.js';


export class Telegram {
    private bot = new Bot(config.tg.token);

    constructor(token: string) {
        this.bot = new Bot(token);

        logger.info(`[TelegramAPI] token = [...${token.slice(-5)}]`);
    }

    public async initBot(
        dbSetFunction: (key: string, value: string) => Promise<true>,
        getReFunction: () => Promise<[string, StreamRecord[]]>,
        ) {
        this.bot.command('get_pin', async ctx => {
            const chatId = ctx?.message?.chat?.id;
            if (!chatId || chatId !== config.tg.adminId) {
                logger.debug(`get_pin: skip message from chat -- ${chatId}`);
                return;
            }

            const msg = await this.bot.api.sendMessage(
                chatId,
                escapeMarkdown(`Loading messageID...`),
                { ...tgBaseOptions as any }
            );
            await dbSetFunction(Database.getChatIdKey(chatId), msg.message_id.toString());
            logger.info(`get_pin: db updated`);

            await sleep(2);
            await this.updatePin(
                chatId,
                msg.message_id,
                escapeMarkdown(`Now this message will be update every minute (${msg.message_id})`)
            );
            logger.info(`get_pin: messageID -- ${msg.message_id}`);
        });

        this.bot.command('get_re',  async (ctx) => {
            const chatId = ctx?.message?.chat?.id;
            if (!chatId || chatId !== config.tg.adminId) {
                logger.debug(`get_pin: skip message from chat -- ${chatId}`);
                return;
            }

            const [state, recordings] = await getReFunction();
            const message = formatRecordings(recordings);

            await this.bot.api.sendMessage(
                chatId,
                (message || 'There is no active recordings') + `\n${state}`,
                { ...tgBaseOptions as any }
            );
        });
    }

    public async sendNotifications(chatId: number, notifications: Notification[]) {
        for (const notification of notifications) {
            if (notification.photo) {
                await this.bot.api.sendPhoto(
                    chatId,
                    notification.photo,
                    {
                        caption: notification.message,
                        ...tgBaseOptions,
                    } as any,
                );

            } else {
                await this.bot.api.sendMessage(chatId, notification.message, { ...tgBaseOptions as any });
            }

            logger.info(`sendNotifications: send -- ${chatId}, ${notification.message}`);
            await sleep(5);
        }
    }

    public async updatePin(chatId: number, msgId: number, message: string): Promise<boolean> {
        try {
            logger.debug(`updatePin: try ${chatId}:${msgId} -- ${message}`);
            await this.bot.api.editMessageText(chatId, msgId, message, { ...tgBaseOptions as any });
            logger.debug(`updatePin: done ${chatId}:${msgId} -- ${message}`);

        } catch (e) {
            logger.warn(`updatePin: can't update message ${chatId}:${msgId}`);

            if (e instanceof GrammyError) {
                if (e.description.startsWith('Bad Request: message is not modified')) {
                    logger.debug(`updatePin: same message error, just ignore`);
                    return true;
                }
            }

            if (e instanceof Error) {
                logger.error(`updatePin: error - ${e.message}`);
            }

            return false;
        }

        return true;
    }

    public async start() {
        return this.bot.start();
    }

}

const tgBaseOptions = {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
};
