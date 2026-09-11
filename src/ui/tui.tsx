import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ApprovalResolver,
} from "../security/approval.js";

export interface TuiApprovalResolver extends ApprovalResolver {
	bind(setter?: (request: ApprovalRequest | undefined) => void): void;
	resolve(decision: ApprovalDecision): void;
	dispose(): void;
}

export interface TuiTranscript {
	append(line: string): void;
	appendToLast(text: string): void;
}

export function createTuiApprovalResolver(): TuiApprovalResolver {
	let resolvePending: ((decision: ApprovalDecision) => void) | undefined;
	let setRequest: ((request: ApprovalRequest | undefined) => void) | undefined;

	return {
		async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
			if (!setRequest) return "unavailable";
			return new Promise<ApprovalDecision>((resolve) => {
				resolvePending = resolve;
				setRequest?.(request);
			});
		},
		bind(setter?: (request: ApprovalRequest | undefined) => void): void {
			setRequest = setter;
		},
		resolve(decision: ApprovalDecision): void {
			resolvePending?.(decision);
			resolvePending = undefined;
			setRequest?.(undefined);
		},
		dispose(): void {
			resolvePending?.("unavailable");
			resolvePending = undefined;
			setRequest = undefined;
		},
	} as TuiApprovalResolver;
}

export interface TuiAppProps {
	approvalResolver: TuiApprovalResolver;
	bindTranscript: (transcript: TuiTranscript) => void;
	onSubmit: (prompt: string) => void;
}

export function TuiApp({
	approvalResolver,
	bindTranscript,
	onSubmit,
}: TuiAppProps): React.JSX.Element {
	const { exit } = useApp();
	const [input, setInput] = useState("");
	const [request, setRequest] = useState<ApprovalRequest>();
	const [transcript, setTranscript] = useState<string[]>([
		"Type a request and press Enter. Press Ctrl+C to exit.",
	]);

	useEffect(() => {
		approvalResolver.bind(setRequest);
		return () => {
			approvalResolver.dispose();
		};
	}, [approvalResolver]);

	useEffect(() => {
		bindTranscript({
			append: (line) => setTranscript((lines) => [...lines, line]),
			appendToLast: (text) =>
				setTranscript((lines) => {
					const last = lines.at(-1) ?? "";
					return [...lines.slice(0, -1), last + text];
				}),
		});
	}, [bindTranscript]);

	useInput((character, key) => {
		if (request) {
			if (character.toLowerCase() === "y") approvalResolver.resolve("approved");
			if (character.toLowerCase() === "n" || key.escape)
				approvalResolver.resolve("denied");
			return;
		}
		if (key.ctrl && character === "c") exit();
		if (key.return && input.trim()) {
			onSubmit(input.trim());
			setInput("");
			return;
		}
		if (key.backspace || key.delete) {
			setInput((value) => value.slice(0, -1));
			return;
		}
		if (!key.ctrl && !key.meta && character)
			setInput((value) => value + character);
	});

	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				ChiselCode
			</Text>
			{transcript.map((line, index) => (
				<Text key={`${index}-${line}`}>{line}</Text>
			))}
			{request ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color="yellow">Approval required for {request.tool}</Text>
					<Text>{request.preview}</Text>
					<Text>Approve? [y/N]</Text>
				</Box>
			) : (
				<Text color="green">› {input}</Text>
			)}
		</Box>
	);
}
