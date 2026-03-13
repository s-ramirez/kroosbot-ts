import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	Message,
	Partials,
	type Snowflake
} from "discord.js";
import type { AppConfig } from "../config.js";
import { type InboundMessage, type OutboundMessage, SessionKey } from "../store.js";

export class DiscordAdapter {
	private readonly client: Client;
	private readonly allowedChannelIds: Set<string>;
	private readonly mentionRoleIds: Set<string>;
	private botUserId?: string;

	constructor(private readonly config: AppConfig["adapters"]["discord"]) {
		this.allowedChannelIds = new Set(config.allowedChannelIds.map((id) => id.trim()).filter(Boolean));
		this.mentionRoleIds = new Set(config.mentionRoleIds.map((id) => id.trim()).filter(Boolean));
		this.client = new Client({
			intents: [
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.MessageContent
			],
			partials: [Partials.Channel]
		});
	}

	async ping(): Promise<void> {
		if (!this.config.enabled) return;
		if (!this.config.token.trim()) {
			throw new Error("discord token is empty");
		}

		const response = await fetch("https://discord.com/api/v10/users/@me", {
			headers: {
				authorization: `Bot ${this.config.token.trim()}`
			}
		});
		if (!response.ok) {
			throw new Error(`discord ping failed (${response.status}): ${await response.text()}`);
		}
		const body = (await response.json()) as { id?: string };
		if (typeof body.id === "string" && body.id.trim()) {
			this.botUserId = body.id;
		}
	}

	async start(onInbound: (message: InboundMessage) => Promise<void>): Promise<void> {
		if (!this.config.enabled) return;

		this.client.once(Events.ClientReady, (client) => {
			this.botUserId = client.user.id;
			console.info("discord gateway ready", { user: client.user.username, botUserId: client.user.id });
		});

		this.client.on(Events.Error, (error) => {
			console.warn("discord gateway error", error);
		});

		this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
			console.warn("discord gateway disconnected", {
				shardId,
				code: closeEvent.code,
				reason: closeEvent.reason
			});
		});

		this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
			console.info("discord gateway resumed", { shardId, replayedEvents });
		});

		this.client.on(Events.MessageCreate, async (message) => {
			console.info("discord message received", {
				messageId: message.id,
				channel: message.channelId,
				guild: message.guildId ?? null,
				author: message.author.id
			});

			if (!this.shouldProcessMessage(message)) return;
			const inbound = this.normalizeInbound(message);
			if (!inbound) {
				console.info("discord message ignored during normalization", {
					messageId: message.id,
					channel: message.channelId
				});
				return;
			}

			console.info("dispatching discord inbound message", {
				session: inbound.sessionKey.toString(),
				channel: message.channelId
			});

			try {
				await onInbound(inbound);
			} catch (error) {
				console.warn("discord inbound handling failed", error);
			}
		});

		await this.client.login(this.config.token);
	}

	async sendText(message: InboundMessage, outbound: OutboundMessage): Promise<void> {
		const channelId = parseChannelTarget(message.deliveryTarget.address);
		const channel = await this.client.channels.fetch(channelId);
		if (!isSendableChannel(channel)) {
			throw new Error(`discord channel is not text-based: ${channelId}`);
		}
		for (const chunk of splitDiscordMessage(outbound.text)) {
			await channel.send(chunk);
		}
		console.info("sent discord reply", {
			session: message.sessionKey.toString(),
			target: message.deliveryTarget.address,
			chunks: splitDiscordMessage(outbound.text).length
		});
	}

	private shouldProcessMessage(message: Message): boolean {
		if (message.author.bot) return false;
		if (!message.guildId) return true;

		if (this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(message.channelId)) {
			console.info("ignoring discord message because channel is not in allowedChannelIds", {
				channel: message.channelId
			});
			return false;
		}
		if (!this.config.requireMention) return true;
		if (!this.botUserId) {
			console.warn("ignoring discord message because bot user id is not initialized yet");
			return false;
		}

		const content = message.content.trim();
		const mentionedDirectly =
			message.mentions.users.has(this.botUserId) ||
			content.includes(`<@${this.botUserId}>`) ||
			content.includes(`<@!${this.botUserId}>`);
		const roleMentioned = message.mentions.roles.some((role) => this.mentionRoleIds.has(role.id));
		const mentioned = mentionedDirectly || roleMentioned;

		if (!mentioned) {
			console.info("ignoring discord guild message because the bot was not mentioned", {
				channel: message.channelId,
				author: message.author.id,
				botUserId: this.botUserId,
				mentionCount: message.mentions.users.size,
				roleMentions: [...message.mentions.roles.keys()]
			});
		}
		return mentioned;
	}

	private normalizeInbound(message: Message): InboundMessage | null {
		if (message.author.bot) return null;

		const isDirect = !message.guildId;
		const content = message.content.trim();
		if (!content) {
			if (!isDirect) {
				console.warn(
					"discord message had empty content; verify Message Content Intent is enabled for the bot",
					{ channel: message.channelId, author: message.author.id }
				);
			}
			return null;
		}

		const isThread = message.channel.isThread();
		const conversationId = message.channelId;
		const threadId = isThread ? message.channelId : undefined;
		const parentId = isThread ? message.channel.parentId ?? message.channelId : message.channelId;

		return {
			adapter: "discord",
			chatKind: isDirect ? "direct" : "channel",
			messageId: message.id,
			sessionKey: isDirect
				? SessionKey.direct("discord", message.author.id)
				: SessionKey.channel("discord", parentId, threadId),
			conversationId,
			threadId,
			deliveryTarget: {
				adapter: "discord",
				address: `channel:${message.channelId}`,
				threadId
			},
			senderId: message.author.id,
			senderName: message.author.globalName ?? message.author.username,
			text: content,
			timestampMs: message.createdTimestamp
		};
	}
}

function parseChannelTarget(address: string): Snowflake {
	if (!address.startsWith("channel:")) {
		throw new Error(`unsupported discord delivery target: ${address}`);
	}
	return address.slice("channel:".length) as Snowflake;
}

function isSendableChannel(
	channel: Awaited<ReturnType<Client["channels"]["fetch"]>>
): channel is NonNullable<Awaited<ReturnType<Client["channels"]["fetch"]>>> & {
	send(content: string): Promise<unknown>;
} {
	return Boolean(
		channel &&
		channel.isTextBased() &&
		"send" in channel &&
		typeof (channel as { send?: unknown }).send === "function"
	);
}

function splitDiscordMessage(text: string, maxLength = 2000): string[] {
	const normalized = text.trim();
	if (!normalized) {
		return [""];
	}
	if (normalized.length <= maxLength) {
		return [normalized];
	}

	const chunks: string[] = [];
	let remaining = normalized;
	while (remaining.length > maxLength) {
		let splitAt = remaining.lastIndexOf("\n", maxLength);
		if (splitAt < maxLength * 0.5) {
			splitAt = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitAt < maxLength * 0.5) {
			splitAt = maxLength;
		}
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) {
		chunks.push(remaining);
	}
	return chunks.filter(Boolean);
}
