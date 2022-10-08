import fs from 'fs';
import { program, Option } from 'commander';
import * as http from 'http';

import { Connection, Commitment, Keypair, PublicKey, clusterApiUrl, AccountMeta, TransactionInstruction, Transaction } from '@solana/web3.js';

import {
	Token,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	getVariant,
	BulkAccountLoader,
	ClearingHouse,
	ClearingHouseUser,
	initialize,
	Wallet,
	DriftEnv,
	EventSubscriber,
	SlotSubscriber,
	convertToNumber,
	QUOTE_PRECISION,
	SpotMarkets,
	PerpMarkets,
	BN,
	BASE_PRECISION,
} from '@drift-labs/sdk';
import { promiseTimeout } from '@drift-labs/sdk/lib/util/promiseTimeout';
import { Mutex } from 'async-mutex';

import { logger, setLogLevel } from './logger';
import { constants } from './types';
import { FillerBot } from './bots/filler';
import { TriggerBot } from './bots/trigger';
import { JitMakerBot } from './bots/jitMaker';
import { PerpLiquidatorBot } from './bots/liquidator';
import { FloatingPerpMakerBot } from './bots/floatingMaker';
import { Bot } from './types';
import { Metrics } from './metrics';
import { PnlSettlerBot } from './bots/pnlSettler';
import bs58 from 'bs58';
import { notify } from './util/notify';

require('dotenv').config();
const driftEnv = process.env.ENV as DriftEnv;
//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });

const stateCommitment: Commitment = 'confirmed';
const healthCheckPort = process.env.HEALTH_CHECK_PORT || 8888;

program
	.option('--test', 'Testing code')
	.option('--airdrop', 'Airdrop USDC for devnet')
	.option('-d, --dry-run', 'Dry run, do not send transactions on chain')
	.option(
		'--init-user',
		'calls clearingHouse.initializeUserAccount if no user account exists'
	)
	.option('--filler', 'Enable filler bot')
	.option('--trigger', 'Enable trigger bot')
	.option('--jit-maker', 'Enable JIT auction maker bot')
	.option('--floating-maker', 'Enable floating maker bot')
	.option('--liquidator', 'Enable liquidator bot')
	.option('--pnl-settler', 'Enable PnL settler bot')
	.option('--cancel-open-orders', 'Cancel open orders on startup')
	.option('--close-open-positions', 'close all open positions')
	.option('--test-liveness', 'Purposefully fail liveness test after 1 minute')
	.option(
		'--force-deposit <number>',
		'Force deposit this amount of USDC to collateral account, the program will end after the deposit transaction is sent'
	)
	.option('--metrics <number>', 'Enable Prometheus metric scraper')
	.addOption(
		new Option(
			'-p, --private-key <string>',
			'private key, supports path to id.json, or list of comma separate numbers'
		).env('KEEPER_PRIVATE_KEY')
	)
	.option('--debug', 'Enable debug logging')
	.parse();

const opts = program.opts();
setLogLevel(opts.debug ? 'debug' : 'info');

notify.info(
	`Dry run: ${!!opts.dry}, FillerBot enabled: ${!!opts.filler}, TriggerBot enabled: ${!!opts.trigger} JitMakerBot enabled: ${!!opts.jitMaker} PnlSettler enabled: ${!!opts.pnlSettler}`
);

export function getWallet(): Wallet {
	const privateKey = process.env.KEEPER_PRIVATE_KEY;
	if (!privateKey) {
		throw new Error(
			'Must set environment variable KEEPER_PRIVATE_KEY with the path to a id.json or a list of commma separated numbers'
		);
	}
	// try to load privateKey as a filepath
	let loadedKey: Uint8Array;
	if (fs.existsSync(privateKey)) {
		notify.info(`loading private key from ${privateKey}`);
		loadedKey = new Uint8Array(
			JSON.parse(fs.readFileSync(privateKey).toString())
		);
	} else {
		notify.info(`loading private key as comma separated numbers`);
		loadedKey = Uint8Array.from(
			privateKey.split(',').map((val) => Number(val))
		);
	}

	const keypair = Keypair.fromSecretKey(Uint8Array.from(loadedKey));
	return new Wallet(keypair);
}

const endpoint = process.env.ENDPOINT;
notify.info(`RPC endpoint: ${endpoint}`);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUserAccountStats(clearingHouseUser: ClearingHouseUser) {
	const freeCollateral = clearingHouseUser.getFreeCollateral();
	notify.info(
		`User free collateral: $${convertToNumber(
			freeCollateral,
			QUOTE_PRECISION
		)}:`
	);

	notify.info(
		`CHUser unrealized funding PnL: ${convertToNumber(
			clearingHouseUser.getUnrealizedFundingPNL(),
			QUOTE_PRECISION
		)}`
	);
	notify.info(
		`CHUser unrealized PnL:         ${convertToNumber(
			clearingHouseUser.getUnrealizedPNL(),
			QUOTE_PRECISION
		)}`
	);
}

function printOpenPositions(clearingHouseUser: ClearingHouseUser) {
	notify.info('Open Perp Positions:');
	for (const p of clearingHouseUser.getUserAccount().perpPositions) {
		if (p.baseAssetAmount.isZero()) {
			continue;
		}
		const market = PerpMarkets[driftEnv][p.marketIndex.toNumber()];
		console.log(`[${market.symbol}]`);
		console.log(
			` . baseAssetAmount:  ${convertToNumber(
				p.baseAssetAmount,
				BASE_PRECISION
			).toString()}`
		);
		console.log(
			` . quoteAssetAmount: ${convertToNumber(
				p.quoteAssetAmount,
				QUOTE_PRECISION
			).toString()}`
		);
		console.log(
			` . quoteEntryAmount: ${convertToNumber(
				p.quoteEntryAmount,
				QUOTE_PRECISION
			).toString()}`
		);

		console.log(
			` . lastCumulativeFundingRate: ${convertToNumber(
				p.lastCumulativeFundingRate,
				new BN(10).pow(new BN(14))
			)}`
		);
		console.log(
			` . openOrders: ${p.openOrders.toString()}, openBids: ${convertToNumber(
				p.openBids,
				BASE_PRECISION
			)}, openAsks: ${convertToNumber(p.openAsks, BASE_PRECISION)}`
		);
	}

	notify.info('Open Spot Positions:');
	for (const p of clearingHouseUser.getUserAccount().spotPositions) {
		if (p.balance.isZero()) {
			continue;
		}
		const market = PerpMarkets[driftEnv][p.marketIndex.toNumber()];
		console.log(`[${market.symbol}]`);
		console.log(
			` . baseAssetAmount:  ${convertToNumber(
				p.balance,
				QUOTE_PRECISION
			).toString()}`
		);
		console.log(` . balanceType: ${getVariant(p.balanceType)}`);
		console.log(
			` . openOrders: ${p.openOrders.toString()}, openBids: ${convertToNumber(
				p.openBids,
				BASE_PRECISION
			)}, openAsks: ${convertToNumber(p.openAsks, BASE_PRECISION)}`
		);
	}
}

const bots: Bot[] = [];
const runBot = async () => {
	if (opts.test) {
		logger.info(bs58.decode('AMbA5aEcoknsMEMSzSjYH5'));
		process.exit();
	}

	const wallet = getWallet();
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);

	const connection = new Connection(clusterApiUrl(driftEnv), stateCommitment);

	const bulkAccountLoader = new BulkAccountLoader(
		connection,
		stateCommitment,
		1000
	);
	const clearingHouse = new ClearingHouse({
		connection,
		wallet,
		programID: clearingHousePublicKey,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
		env: driftEnv,
		userStats: true,
	});

	const eventSubscriber = new EventSubscriber(
		connection,
		clearingHouse.program,
		{
			maxTx: 8192,
			maxEventsPerType: 8192,
			orderBy: 'blockchain',
			orderDir: 'desc',
			commitment: stateCommitment,
			logProviderConfig: {
				type: 'polling',
				frequency: 1000,
				// type: 'websocket',
			},
		}
	);

	const slotSubscriber = new SlotSubscriber(connection, {});
	const lastSlotReceivedMutex = new Mutex();
	let lastSlotReceived: number;
	let lastHealthCheckSlot = -1;
	const startupTime = Date.now();

	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	notify.info(
		`ClearingHouse ProgramId: ${clearingHouse.program.programId.toBase58()}`
	);
	notify.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	notify.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);

	const tokenAccount = await Token.getAssociatedTokenAddress(
		ASSOCIATED_TOKEN_PROGRAM_ID,
		TOKEN_PROGRAM_ID,
		new PublicKey(constants.devnet.USDCMint),
		wallet.publicKey
	);
	const USDC_TOKEN = new Token(
		connection, 
		new PublicKey(constants.devnet.USDCMint),
		TOKEN_PROGRAM_ID,
		wallet.payer
	);

	const walletUSDC = await USDC_TOKEN.getOrCreateAssociatedAccountInfo(wallet.publicKey);

	if (opts.airdrop) {
		const response = await airdrop(
			connection,
			USDC_TOKEN,
			walletUSDC.address,
			wallet
		);

		if (response.value.err == null) {
			logger.info('airdropped USDC!');
			logger.info('exiting...run again without --airdrop flag');
			process.exit();
		}
	}
		
	const usdcBalance = await connection.getTokenAccountBalance(tokenAccount);
	notify.info(` . USDC balance: ${usdcBalance.value.uiAmount}`);

	await clearingHouse.subscribe();
	clearingHouse.eventEmitter.on('error', (e) => {
		notify.info('clearing house error');
		notify.error(e);
	});

	eventSubscriber.subscribe();
	await slotSubscriber.subscribe();
	slotSubscriber.eventEmitter.on('newSlot', async (slot: number) => {
		await lastSlotReceivedMutex.runExclusive(async () => {
			lastSlotReceived = slot;
		});
	});

	if (!(await clearingHouse.getUser().exists())) {
		notify.error(`ClearingHouseUser for ${wallet.publicKey} does not exist`);
		if (opts.initUser) {
			notify.info(`Creating ClearingHouseUser for ${wallet.publicKey}`);
			const [txSig] = await clearingHouse.initializeUserAccount();
			notify.info(`Initialized user account in transaction: ${txSig}`);
		} else {
			throw new Error(
				"Run with '--init-user' flag to initialize a ClearingHouseUser"
			);
		}
	}

	// subscribe will fail if there is no clearing house user
	const clearingHouseUser = clearingHouse.getUser();
	while (
		!(await clearingHouse.subscribe()) ||
		!(await clearingHouseUser.subscribe()) ||
		!eventSubscriber.subscribe()
	) {
		logger.info('waiting to subscribe to ClearingHouse and ClearingHouseUser');
		await sleep(1000);
	}
	notify.info(
		`ClearingHouseUser PublicKey: ${clearingHouseUser
			.getUserAccountPublicKey()
			.toBase58()}`
	);
	await clearingHouse.fetchAccounts();
	await clearingHouse.getUser().fetchAccounts();

	let metrics: Metrics | undefined = undefined;
	if (opts.metrics) {
		metrics = new Metrics(clearingHouse, parseInt(opts?.metrics));
		await metrics.init();
		metrics.trackObjectSize('clearingHouse', clearingHouse);
		metrics.trackObjectSize('clearingHouseUser', clearingHouseUser);
		metrics.trackObjectSize('eventSubscriber', eventSubscriber);
	}

	printUserAccountStats(clearingHouseUser);
	if (opts.closeOpenPositions) {
		notify.info(`Closing open spot positions`);
		let closedPerps = 0;
		for await (const p of clearingHouseUser.getUserAccount().perpPositions) {
			if (p.baseAssetAmount.isZero()) {
				logger.info(`no position on market: ${p.marketIndex.toNumber()}`);
				continue;
			}
			logger.info(`closing position on ${p.marketIndex.toNumber()}`);
			logger.info(` . ${await clearingHouse.closePosition(p.marketIndex)}`);
			closedPerps++;
		}
		notify.info(`Closed ${closedPerps} perp positions`);

		let closedSpots = 0;
		for await (const p of clearingHouseUser.getUserAccount().spotPositions) {
			if (p.balance.isZero()) {
				logger.info(`no position on market: ${p.marketIndex.toNumber()}`);
				continue;
			}
			logger.info(`closing position on ${p.marketIndex.toNumber()}`);
			logger.info(` . ${await clearingHouse.closePosition(p.marketIndex)}`);
			closedSpots++;
		}
		notify.info(`Closed ${closedSpots} spot positions`);
	}

	// check that user has collateral
	const freeCollateral = clearingHouseUser.getFreeCollateral();
	if (freeCollateral.isZero() && opts.jitMaker && !opts.forceDeposit) {
		throw new Error(
			`No collateral in account, collateral is required to run JitMakerBot, run with --force-deposit flag to deposit collateral`
		);
	}
	if (opts.forceDeposit) {
		logger.info(
			`Depositing (${new BN(
				opts.forceDeposit
			).toString()} USDC to collateral account)`
		);

		if (opts.forceDeposit < 0) {
			logger.error(`Deposit amount must be greater than 0`);
			throw new Error('Deposit amount must be greater than 0');
		}

		const ata = await Token.getAssociatedTokenAddress(
			ASSOCIATED_TOKEN_PROGRAM_ID,
			TOKEN_PROGRAM_ID,
			SpotMarkets[driftEnv][0].mint, // TODO: are index 0 always USDC???, support other collaterals
			wallet.publicKey
		);

		const tx = await clearingHouse.deposit(
			new BN(opts.forceDeposit).mul(QUOTE_PRECISION),
			new BN(0), // USDC bank
			ata
		);
		logger.info(`Deposit transaction: ${tx}`);
		logger.info(`exiting...run again without --force-deposit flag`);
		return;
	}

	// print user orders
	notify.info('');
	notify.info('Open orders:');
	const ordersToCancel: Array<BN> = [];
	for (const order of clearingHouseUser.getUserAccount().orders) {
		if (order.baseAssetAmount.isZero()) {
			continue;
		}
		console.log(order);
		ordersToCancel.push(order.orderId);
	}
	if (opts.cancelOpenOrders) {
		for (const order of ordersToCancel) {
			notify.info(`Cancelling open order ${order.toString()}`);
			await clearingHouse.cancelOrder(order);
		}
	}

	printOpenPositions(clearingHouseUser);

	/*
	 * Start bots depending on flags enabled
	 */

	if (opts.filler) {
		bots.push(
			new FillerBot(
				'filler',
				!!opts.dry,
				clearingHouse,
				slotSubscriber,
				metrics
			)
		);
	}
	if (opts.trigger) {
		bots.push(
			new TriggerBot(
				'trigger',
				!!opts.dry,
				clearingHouse,
				slotSubscriber,
				metrics
			)
		);
	}
	if (opts.jitMaker) {
		bots.push(
			new JitMakerBot(
				'JitMaker',
				!!opts.dry,
				clearingHouse,
				slotSubscriber,
				metrics
			)
		);
	}
	if (opts.liquidator) {
		bots.push(
			new PerpLiquidatorBot('liquidator', !!opts.dry, clearingHouse, metrics)
		);
	}
	if (opts.floatingMaker) {
		bots.push(
			new FloatingPerpMakerBot(
				'floatingMaker',
				!!opts.dry,
				clearingHouse,
				slotSubscriber,
				metrics
			)
		);
	}

	if (opts.pnlSettler) {
		bots.push(
			new PnlSettlerBot(
				'pnlSettler',
				!!opts.dry,
				clearingHouse,
				PerpMarkets[driftEnv],
				SpotMarkets[driftEnv],
				metrics
			)
		);
	}

	notify.info(`initializing bots`);
	await Promise.all(bots.map((bot) => bot.init()));

	notify.info(`starting bots`);
	await Promise.all(
		bots.map((bot) => bot.startIntervalLoop(bot.defaultIntervalMs))
	);

	eventSubscriber.eventEmitter.on('newEvent', async (event) => {
		Promise.all(bots.map((bot) => bot.trigger(event)));
	});

	// start http server listening to /health endpoint using http package
	http
		.createServer(async (req, res) => {
			if (req.url === '/health') {
				if (opts.testLiveness) {
					if (Date.now() > startupTime + 60 * 1000) {
						res.writeHead(500);
						res.end('Testing liveness test fail');
						return;
					}
				}
				// check if a slot was received recently
				let healthySlot = false;
				await lastSlotReceivedMutex.runExclusive(async () => {
					healthySlot = lastSlotReceived > lastHealthCheckSlot;
					notify.debug(
						`Health check: lastSlotReceived: ${lastSlotReceived}, lastHealthCheckSlot: ${lastHealthCheckSlot}, healthySlot: ${healthySlot}`
					);
					if (healthySlot) {
						lastHealthCheckSlot = lastSlotReceived;
					}
				});
				if (!healthySlot) {
					res.writeHead(500);
					res.end(`SlotSubscriber is not healthy`);
					return;
				}

				// check all bots if they're live
				for (const bot of bots) {
					const healthCheck = await promiseTimeout(bot.healthCheck(), 1000);
					if (!healthCheck) {
						logger.error(`Health check failed for bot ${bot.name}`);
						res.writeHead(500);
						res.end(`Bot ${bot.name} is not healthy`);
						return;
					}
				}

				// liveness check passed
				res.writeHead(200);
				res.end('OK');
			} else {
				res.writeHead(404);
				res.end('Not found');
			}
		})
		.listen(healthCheckPort);
		notify.info(`Health check server listening on port ${healthCheckPort}`);
};

async function recursiveTryCatch(f: () => void) {
	try {
		await f();
	} catch (e) {
		console.error(e);
		for (const bot of bots) {
			bot.reset();
			await bot.init();
		}
		await sleep(15000);
		await recursiveTryCatch(f);
	}
}

/**
 * Airdrops Devnet USDC to the bot wallet
 * @param connection Solana Connection
 * @param mintToken the USDC SPL Token
 * @param recipientTokenAddress the reciepient's token address
 * @param wallet the tx payer
 * @returns confirmed transaction or error
 */
 const airdrop = async (
	connection: Connection,
	mintToken: Token,
	recipientTokenAddress: PublicKey,
	wallet: Wallet
) => {
	const faucetPublicKey = new PublicKey(
		'7GWXZ5esgVjUek9zDapKN5QAXPFLT2E7MafLb1p7zF6U'
	);
	const faucetProgramId = new PublicKey(
		'V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB'
	);

	try {
		const keys = [
			{
				pubkey: new PublicKey('A5TtJFy3PgCSg9MdBHLCHtewa7Sx613heaJ5atjNZCtJ'),
				isSigner: false,
				isWritable: false,
			},
			{
				pubkey: mintToken.publicKey,
				isSigner: false,
				isWritable: true,
			},
			{ pubkey: recipientTokenAddress, isSigner: false, isWritable: true },
			{ pubkey: faucetPublicKey, isSigner: false, isWritable: false },
			{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
		] as Array<AccountMeta>;

		const txIX = new TransactionInstruction({
			programId: faucetProgramId,
			data: Buffer.from(bs58.decode('AMbA5aEcoknsMEMSzSjYH5')), // taken from successful airdrop tx data
			keys,
		});

		const tx = new Transaction().add(txIX);

		tx.recentBlockhash = (
			await connection.getRecentBlockhash('processed')
		).blockhash;

		tx.sign(wallet.payer);
		const signature = await connection.sendRawTransaction(tx.serialize(), {
			skipPreflight: true,
			preflightCommitment: 'processed',
		});
		logger.info('sent tx: ' + signature);
		return await connection.confirmTransaction(signature, 'processed');
	} catch (error) {
		logger.error(error);
		return error;
	}
};

recursiveTryCatch(() => runBot());
