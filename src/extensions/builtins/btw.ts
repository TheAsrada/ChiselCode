import { MODEL_REQUEST_LIMITS } from "../../models/contracts.js";
import type { ChiselExtension } from "../contracts.js";

/** Production consumer; core owns capture, transport, output and persistence. */
export const btwExtension: ChiselExtension = {
  id: "builtin.btw",
  activate(context) {
    context.commands.register({
      name: "btw",
      description: "побочный вопрос к модели без остановки основной задачи",
      usage: "/btw <вопрос>",
      executionPolicy: "side_query",
      parse(args: string) {
        const question = args.trim();
        if (
          !question ||
          Buffer.byteLength(question, "utf8") >
            MODEL_REQUEST_LIMITS.questionBytes
        )
          throw new Error("Укажите вопрос длиной до 8 KiB.");
        return question;
      },
      execute(invocation, question) {
        return invocation.model.request({
          text: question,
          context: "conversation",
        });
      },
    });
  },
};
