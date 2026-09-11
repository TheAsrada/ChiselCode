import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_FILE = "credentials.enc";

function configDirectory(): string {
	if (process.platform === "win32")
		return join(
			process.env.APPDATA ?? process.env.USERPROFILE ?? process.cwd(),
			"chiselcode",
		);
	return join(
		process.env.XDG_CONFIG_HOME ??
			join(process.env.HOME ?? process.cwd(), ".config"),
		"chiselcode",
	);
}

export class CredentialStore {
	async get(name: string): Promise<string | undefined> {
		try {
			const payload = JSON.parse(
				await readFile(join(configDirectory(), FALLBACK_FILE), "utf8"),
			) as EncryptedCredentialFile;
			return decrypt(payload)[name];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(
				"Unable to decrypt ChiselCode credentials. Delete the credential fallback file and save this key again.",
			);
		}
	}

	async set(name: string, secret: string): Promise<void> {
		const directory = configDirectory();
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const file = join(directory, FALLBACK_FILE);
		let credentials: Record<string, string> = {};
		try {
			credentials = decrypt(
				JSON.parse(await readFile(file, "utf8")) as EncryptedCredentialFile,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		credentials[name] = secret;
		await writeFile(file, `${JSON.stringify(encrypt(credentials))}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
}

interface EncryptedCredentialFile {
	version: 1;
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

function encryptionKey(salt: Buffer): Buffer {
	const material = `${process.env.USERNAME ?? process.env.USER ?? "unknown"}:${process.env.USERPROFILE ?? process.env.HOME ?? "unknown"}:chiselcode`;
	return scryptSync(material, salt, 32);
}

function encrypt(credentials: Record<string, string>): EncryptedCredentialFile {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", encryptionKey(salt), iv);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(credentials), "utf8"),
		cipher.final(),
	]);
	return {
		version: 1,
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

function decrypt(payload: EncryptedCredentialFile): Record<string, string> {
	if (payload.version !== 1)
		throw new Error("Unsupported credential file version.");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		encryptionKey(Buffer.from(payload.salt, "base64")),
		Buffer.from(payload.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(payload.ciphertext, "base64")),
		decipher.final(),
	]);
	return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
}
