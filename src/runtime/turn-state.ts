export type TurnState =
  | "preparing_context"
  | "calling_provider"
  | "processing_response"
  | "executing_tools"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
