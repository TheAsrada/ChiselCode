# События агента в расширениях

[Разработка расширений](README.md) · [Инструменты и команды](tools-commands.md) · [Интерактивные панели](interactive-ui.md)

Дополнение SDK v1 в текущих исходниках, **Unreleased**. Добавьте `"requires":["agent.events"]` в manifest. Это API стандартного пакета: UI-пакет с `kind:"ui"` не регистрирует runtime middleware. После включения стандартного пакета нужен перезапуск. Он может одновременно регистрировать UI и держать общее состояние обработчиков и панели внутри activation.

## Цепочка обработчиков

```js
ctx.events.on("tool.call", async (event, next) => {
  if (event.data.name === "read_file" && event.data.input.path === "alias.txt") {
    return next({...event.data, input: {path: "actual.txt"}});
  }
  return next();
});
ctx.events.on("model.response", async (_event, next) => {
  const response = await next();
  return {...response, message: {
    ...response.message,
    content: response.message.content.map(block => block.type === "text"
      ? {...block, text: block.text.trim()}
      : block)
  }};
});
```

Handler получает `{type,data,workspaceRoot,sessionId,turnId?,signal}`. `data` — отдельная глубоко замороженная копия. `next()` продолжает цепочку с текущими данными; `next(data)` передаёт замену следующему обработчику. Порядок совпадает с activation и регистрацией. Продолжение допускается один раз и только пока handler выполняется. Оно собирает проверенное решение; эффекты запускает core после завершения цепочки. Для замены результата верните ответ без `next`.

| Событие | `data` | Возвращаемое решение |
| --- | --- | --- |
| `prompt.submit` | `{text}` | `{text}`; изменённый текст сохраняется в истории. Возобновление без нового сообщения не вызывает этот hook. |
| `model.request` | `{model,system,messages,maxTokens?}` | `{request: data}` или `{response:{message,stopReason,usage?}}`. Выбор модели действует в текущем провайдере и не меняет модель следующих ходов. |
| `model.response` | `{message,stopReason,usage?}` | Та же структура с изменённым ответом. Фактический usage менять нельзя. |
| `tool.call` | `{callId,name,input}` | `{call: data}` или `{result:{output,...}}` без выполнения инструмента. `callId` неизменяем. |
| `tool.result` | `{callId,name,result}` | `{result}`. Работает после успешного выполнения и сохранения исходного результата, до сохранения изменённого ответа; исходные ошибки и отказы через него не проходят. |

Ответ инструмента из hook принимает только `output`, `rawOutput?`, `preview?`, `isError?`, `errorCode?`, `details?`. Нельзя создать diff, artifact authority или approval receipt через middleware. Синтетический результат явно помечается в выводе как ответ расширения без выполнения. Реальные diff, ownership и результаты сохраняет core.

Для временной остановки handler может ожидать собственный Promise; локальная кнопка панели, зарегистрированная через `ctx.ui.on`, завершает ожидание. Учитывайте `event.signal`: Ctrl+C и закрытие владельца прекращают ожидание. Обычное подтверждение инструмента после продолжения сохраняется. Прямой доступ к approval arbiter не предоставляется.

## Семантика runtime

Перехват применяется к основному агенту и помощникам; model hooks также работают в model port команд. Контекстные служебные summaries не проходят через этот API. Набор доступных инструментов, профиль и transport policy остаются core-owned; middleware не повышает бюджет вывода запроса. После изменения имени или аргументов инструмента заново выполняются разбор, prepare, Plan, permissions, guards, policy rechecks, coordinator и обычное подтверждение.

Помощник использует активированные обработчики родителя с собственными `workspaceRoot`, session ID и сигналом отмены. Пакет повторно не импортируется, его tools не добавляются в разрешённый набор помощника. Закрытие помощника снимает только его привязку, а закрытие родительского scope прекращает все его обработчики.

Результат уже завершённого вызова возвращается из durable record без повторного hook и эффекта. Незавершённая запись не превращается в разрешение на replay. Ожидания и поздние результаты остаются у исходного session/call owner; закрытие UI не переносит их в другую беседу.

`model.response` обрабатывает законченный ответ, поэтому при его наличии текст сначала собирается, затем показывается после фильтрации. В историю и в ленту поступает один и тот же итог. Реальный usage и стоимость относятся к фактической модели; локальный синтетический ответ не изображает сетевой расход. Нельзя скрыть настоящий отказ провайдера изменением stop reason.

Ошибка структуры или callback возвращает `EXTENSION_HOOK_FAILED` с владельцем обработчика; она не выдаётся за ошибку провайдера. Результат effect, который уже успел выполниться, остаётся в записи выполнения. Общая отмена и существующие checkpoint/artifact механизмы сохраняются.

## Наблюдение

```js
ctx.events.observe(event => {
  if (event.type === "tool_completed") {
    // Update activation-owned state keyed by event.sessionId,
    // then notify the corresponding UI source subscriptions.
  }
});
```

Observer получает отдельное очищенное событие runtime с `sessionId`, `turnId?`, `invocationId?`, названием, состоянием и доступным итогом. Он не заменяет событие host и не получает mutable Session. Ошибка observer отключает только этот observer и показывает короткое уведомление; выполненное действие не становится неуспешным из-за оформления. Обработчики и подписки снимаются при rollback/dispose существующего workspace lifecycle.
