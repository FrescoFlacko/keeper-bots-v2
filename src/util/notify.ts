import axios from "axios";
import { logger } from "../logger";

require('dotenv').config();

export const notify = {
    info: (message, ...meta) => { 
        logger.info(message, meta);
        sendDiscordMsg(message);
    },
    error: (message, ...meta) => { 
        logger.error(message, meta);
        sendDiscordMsg(message);
    },
    debug: (message, ...meta) => { 
        logger.debug(message, meta);
        sendDiscordMsg(message);
    }
};

function sendDiscordMsg(content: string) {
    try {
        axios.post(process.env.WEBHOOK_URL, { content }).catch(e => {
            logger.info('Error trying to send Discord message: ', e);
        });
    } catch (err) {
        logger.error('Error posting to notify webhook:', err);
    }
}