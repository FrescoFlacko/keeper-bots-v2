import axios from "axios";
import { logger } from "src/logger";

const WEBHOOK_URL = process.env.WEBHOOK_URL;

export const notify = {
    info: (message, ...meta) => { 
        logger.info(message, meta);
        axios.post(WEBHOOK_URL, { message });
    },
    error: (message, ...meta) => { 
        logger.error(message, meta);
        axios.post(WEBHOOK_URL, { message });
    },
    debug: (message, ...meta) => { 
        logger.debug(message, meta);
        axios.post(WEBHOOK_URL, { message });
    }
};