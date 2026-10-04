# Web Search / Web Fetch

[Документация](README.md) · [Настройки](configuration.md) · [Безопасность](security.md)

Агент может найти актуальную публичную документацию, открыть нужные страницы, проверить API и продолжить работу над кодом. Web доступен в Plan и Build; изменение файлов по-прежнему требует Build и действующих разрешений.

```text
Найди актуальную официальную документацию React по Server Actions,
проверь реализацию в этом проекте и исправь её. Укажи использованные источники.
```

## Начать пользоваться

Откройте `/settings` → Web. Включите доступ и оставьте «Спрашивать» для поиска и открытия страниц. По умолчанию поиск готов без регистрации и отдельного ключа: используется официальный [публичный Exa MCP](https://exa.ai/docs/reference/exa-mcp). Бесплатный доступ имеет лимиты сервиса; ChiselCode не обещает безлимитный поиск.

«Сервис поиска» переключается между **Авто / Exa / Brave**. Авто использует существующий ключ Brave, если он доступен, иначе Exa. Явный выбор Exa всегда работает без ключа; явный Brave требует вашего ключа и не переключает сервис незаметно при ошибке. Настроенные Brave credentials сохраняются при переключении.

```sh
chisel web configure --search-provider exa
chisel web status
```

Если нужен собственный поисковый тариф, выберите Brave и введите ключ [Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search) в скрытое поле Settings: CredentialStore сохранит ключ зашифрованным, а конфигурация — только `secretRef`. Можно использовать окружение:

```sh
chisel web configure --key-env BRAVE_SEARCH_API_KEY
chisel web status
```

Установите значение `BRAVE_SEARCH_API_KEY` средствами своей ОС/терминала. Не передавайте секрет в argv, `.chiselrc` или сообщении агенту. Search backend независим от выбранной LLM; расходы Brave учитываются отдельно от tokens модели. `web_fetch` работает независимо от сервиса поиска.

## Подтверждения

Первый поиск показывает запрос и backend, открытие страницы — URL и домен. **Y** разрешает один раз, **A** разрешает поиск или точный домен на текущую сессию, **N / Esc** отклоняет. Grant поиска не разрешает все найденные сайты. Для параллельных calls подтверждения идут последовательно; после domain grant страницы этого домена не вызывают новые попапы.

Session grants хранятся в памяти процесса, изолированы по workspace/session ID и не восстанавливаются из сохранённого transcript после перезапуска. Постоянные Ask/Allow/Deny задаются в Settings отдельно для search/fetch. Для постоянного allow конкретных доменов:

```sh
chisel web configure --allow-domain react.dev docs.rs developer.mozilla.org
chisel web configure --deny-domain '*.internal.example.com'
```

Точное правило относится к hostname, `*.example.com` — только к поддоменам; apex добавляется отдельно. Deny и полное отключение Web имеют приоритет над grants и Bypass. Accept edits не выдаёт сетевые разрешения. Dont Ask отклоняет всё, что потребовало бы approval. Project `.chiselrc` может только ограничивать доступ; клонированный репозиторий не может сам разрешить интернет.

Redirect внутри разрешённого домена проверяется автоматически. Другой hostname требует действующего grant: при `WEB_NETWORK_DENIED` агент может отдельно вызвать fetch публичного destination URL и получить обычный approval. Permission policy и проверка безопасных адресов — разные уровни.

## Что видит агент и чат

`web_search` возвращает до 10 компактных title/URL/domain/snippet с domain filters. Агенту предписано предпочитать официальные источники, открывать важные результаты через fetch и ссылаться на фактические final URLs. Snippet сам по себе не считается подтверждением факта.

`web_fetch` читает HTML, Markdown, plain text и JSON. Удаляются scripts, navigation, footer, очевидные ads/cookie noise и hidden elements; сохраняются title, headings, paragraphs, lists, tables и code examples. JavaScript не исполняется. Title, requested/final URL, fetchedAt и contentType сохраняются в session metadata.

В чате отображаются компактные строки: поисковый запрос и число результатов, открытый домен, title, final URL и объём извлечения. Большие документы сохраняются в закрытый artifact store с коротким preview и `tool-result://…`; агент читает нужные строки через `read_tool_result`. Resume сохраняет источники, результаты и их отображение.

Cache хранит извлечённый текст в пределах сессии: default TTL 5 минут, максимум 16 документов/2 MiB на сессию, ограниченное число активных caches. Fragment удаляется, redirect aliases используют final URL. Cache hit тоже проверяет действующие permissions. `cacheTtlMs: 0` отключает cache.

## Какие данные уходят в интернет

Выбранный сервис Exa или Brave получает текст поискового запроса и domain filters. Exa не получает session ID, имя модели или контекст проекта. Владелец страницы получает URL fetch, обычные HTTP headers и IP соединения. Контекст проекта, исходники, cookies и login credentials автоматически не отправляются. Агент может включить данные задачи в query или URL — избегайте конфиденциальных запросов. При использовании proxy сеть проходит через настроенную пользователем корпоративную инфраструктуру.

Ключ Brave отправляется только фиксированному HTTPS API backend, не странице и не redirect destination. Credentials хранятся за ссылками; известные значения редактируются до events, tool results, artifacts и session checkpoints. Исключение для явно настроенной корпоративной аутентификации — scoped mTLS: сертификат предлагается только адресам из `CHISEL_CLIENT_CERT_HOSTS`, закрытый ключ и его passphrase не передаются.

Полученный текст — **недоверенные reference data**. Инструкции сайта вроде «ignore the user» или «delete package.json» остаются содержимым документа. Короткая метка сохраняется при чтении любого диапазона web artifact; обычные permissions и workspace policy продолжают действовать. Это не обещание полной защиты конкретной LLM от prompt injection.

## Безопасное чтение и пределы

Native fetch всегда блокирует localhost, private/reserved IPv4/IPv6, link-local, metadata, `.local`, нестандартные protocols и порты, embedded credentials и чувствительные URL parameters. Допускаются публичные HTTP/HTTPS на 80/443. DNS проверяется целиком, соединение открывается к проверенному IP с проверкой TLS для исходного hostname. Каждый redirect проверяется заново. Bypass не отключает эту защиту; unsafe/local-network режима нет.

Default пределы: 8 секунд ожидания соединения/headers, 30 секунд полного запроса, 5 redirects, 2 MiB скачанных и 4 MiB распакованных данных, 100000 извлечённых символов. Нормализованные URL, включая redirects и результаты поиска, ограничены 4096 символами. Fetch обычно запрашивает до 30000 символов. DOM ограничен по числу узлов и глубине, очень длинные строки сокращаются. Параллельность — 3 web requests, process rate — до 120/min с интервалом между стартами, turn budget — 24 calls/requests. Ctrl+C отменяет ожидание и socket текущего запроса. [Все настройки](configuration.md#native-web).

Web policy относится к native Web tools, не является OS firewall и не изменяет отдельные полномочия shell/MCP.

## CLI и troubleshooting

```sh
chisel --json web status
chisel web test --url https://example.com/
chisel --allow web_fetch web test --url https://example.com/
chisel --allow web_search,web_fetch web test --search 'React Server Actions docs'
chisel web configure --search ask --fetch ask
chisel web configure --disable
```

`status` не делает HTTP запросов. `test` использует общий ToolExecutor и permissions; без grant возвращает `approval_required` и exit 2. Headless `chisel --json "Найди документацию"` тоже не разрешает сеть автоматически. API errors дают controlled tool failures; локальные инструменты продолжают работать.

| Ошибка | Что сделать |
| --- | --- |
| `WEB_SEARCH_NOT_CONFIGURED` | Для Brave сохраните ключ или переключитесь на Авто / Exa без ключа |
| `WEB_NETWORK_CONFIGURATION` | Проверьте proxy, CA и mTLS: [корпоративная сеть](network.md) |
| `WEB_NETWORK_DENIED` | Проверьте Ask/Allow/Deny и domain rules; разрешите публичный сайт в обычном approval |
| `WEB_UNSAFE_ADDRESS` | Используйте публичную документацию; private/metadata адреса не поддерживаются |
| `WEB_TIMEOUT`, `WEB_FETCH_FAILED` | Проверьте публичную доступность сервера и сетевые ограничения |
| `WEB_HTTP_ERROR` | Сервер вернул HTTP error; 401/403/login flows автоматически не обходятся |
| `WEB_TOO_LARGE` | Выберите меньшую страницу или конкретный текстовый endpoint |
| `WEB_REDIRECT_LIMIT` | Проверьте исходный URL и цепочку redirect |
| `WEB_UNSUPPORTED_CONTENT` | Нужен текстовый документ; PDF, binaries и JS-only/login страницы не поддерживаются |
| `WEB_RATE_LIMITED`, `WEB_REQUEST_LIMIT` | Продолжите с собранными источниками, повторите позже или выберите собственный Brave; лимиты Exa/Brave учитываются отдельно |
| `WEB_PROTOCOL_ERROR` | Ответ сервера повреждён/оборван или backend вернул неверный JSON |

Fetch не запускает Chromium, Playwright, login forms или JavaScript. Корпоративные HTTP/HTTPS proxy, дополнительные CA и scoped mTLS поддерживаются: [настройка](network.md). Web использует CONNECT к проверенному IP, а не доверяет proxy повторное разрешение model-selected hostname. Proxy, допускающий CONNECT только к именам хостов, должен разрешить проверенные публичные IP; небезопасного fallback с повторным DNS нет. SOCKS, NTLM/Kerberos и PDF не поддерживаются.
