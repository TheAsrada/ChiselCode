# Web Search / Web Fetch

[Документация](README.md) · [Настройки](configuration.md) · [Безопасность](security.md)

Агент может найти актуальную публичную документацию, открыть нужные страницы, проверить API и продолжить работу над кодом. Web доступен в Plan и Build; изменение файлов по-прежнему требует Build и действующих разрешений.

```text
Найди актуальную официальную документацию React по Server Actions,
проверь реализацию в этом проекте и исправь её. Укажи использованные источники.
```

## Начать пользоваться

Откройте `/settings` → Web. Доступ включён, поиск и открытие публичных страниц по умолчанию стоят в «Разрешено» и не требуют approval. Пользовательские и проектные deny rules действуют всегда. Поиск готов без регистрации и отдельного ключа: используется официальный [публичный Exa MCP](https://exa.ai/docs/reference/exa-mcp). Бесплатный доступ имеет лимиты сервиса; ChiselCode не обещает безлимитный поиск. При желании отдельно включите «Спрашивать» для поиска или открытия страниц.

По умолчанию «Сервис поиска» стоит в **Авто**: Exa → [Parallel](https://docs.parallel.ai/integrations/mcp/search-mcp), без регистрации и обязательного API-ключа. Сохранённый ключ Brave добавляет его первым. При недоступности, квоте или некорректном результате текущего сервиса Авто пробует следующий разрешённый; успешный ответ, включая пустой, завершает поиск. Цепочка ограничена общим timeout и обычным web budget.

Можно вручную выбрать **Exa / Parallel / Brave**. Явный Exa или Parallel работает без ключа и не переключает сервис при ошибке; Brave требует вашего ключа. Настроенные Brave credentials сохраняются при переключении.

```sh
chisel web configure --search-provider auto
chisel web status
```

Если нужен собственный поисковый тариф, выберите Brave и введите ключ [Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search) в скрытое поле Settings: CredentialStore сохранит ключ зашифрованным, а конфигурация — только `secretRef`. Можно использовать окружение:

```sh
chisel web configure --key-env BRAVE_SEARCH_API_KEY
chisel web status
```

Установите значение `BRAVE_SEARCH_API_KEY` средствами своей ОС/терминала. Не передавайте секрет в argv, `.chiselrc` или сообщении агенту. Search backend независим от выбранной LLM; расходы Brave учитываются отдельно от tokens модели. `web_fetch` работает независимо от сервиса поиска.

## Когда агент обращается к Web

Не нужно выбирать web-инструмент вручную или писать его имя в запросе. Агент получает их схемы и инструкции вместе с текущим каталогом. Для актуальной документации, неизвестного API, точной ошибки, миграции или version-sensitive поведения он может сам выполнить поиск, выбрать релевантные официальные источники, открыть нужные страницы и применить проверенные сведения к коду. Для известного публичного URL используется fetch напрямую; обычная локальная правка не требует поиска.

Выдержки из поиска помогают выбрать источник, но не заменяют проверку страницы. Итог ссылается на final URLs реально открытых документов. Большие материалы читаются через artifacts; повторное открытие той же страницы использует ограниченный session cache. При отключённом Web или отсутствующем ключе явно выбранного Brave инструкции сообщают о недоступности и не обещают проверку интернета. Конкретные решения принимает выбранная модель; доступ и эффект вызовов независимо проверяются executor и permissions.

Parallel подключается через официальный анонимный Search MCP. Настройки расширенного authenticated source policy в этом режиме не действуют: ChiselCode передаёт поисковые операторы и обязательно проверяет domains/excludeDomains и limit на полученных ссылках. Его remote `web_fetch` не подключается: страницы читает собственный безопасный fetch ChiselCode. Необязательные analytics-поля и protocol envelopes не попадают в модельный ответ.

## Доступ и подтверждения

По умолчанию `permissions.search` и `permissions.fetch` равны `allow`: публичные источники доступны сразу в Manual, Accept edits и Dont Ask, в Plan/Build и headless. Allow не отключает SSRF, deny rules, TLS, quotas или проверку redirects. Авто исключает запрещённые сервисы; отмена, network deny, SSRF, HTTP 403 и общие лимиты не запускают обходной запрос.

При явно выбранном Ask поиск показывает запрос и backend, а в Авто — возможные сервисы и endpoints. Открытие страницы показывает URL и домен. **Y** разрешает один раз, **A** разрешает поиск или точный домен на текущую сессию, **N / Esc** отклоняет. Grant поиска не разрешает все найденные сайты, для которых пользователь включил Ask. Для параллельных calls подтверждения идут последовательно; после domain grant страницы этого домена не вызывают новые попапы.

Session grants хранятся в памяти процесса, изолированы по workspace/session ID и не восстанавливаются из сохранённого transcript после перезапуска. Постоянные Ask/Allow/Deny задаются в Settings отдельно для search/fetch. Сохранённые явные Ask/Deny не заменяются новыми дефолтами; отсутствующие поля получают Allow. `allowDomains` избавляет от подтверждений выбранных доменов при Fetch Ask и не ограничивает общий доступ при Fetch Allow. Для Ask с исключениями:

```sh
chisel web configure --fetch ask --allow-domain react.dev docs.rs developer.mozilla.org
chisel web configure --deny-domain '*.internal.example.com'
```

Точное правило относится к hostname, `*.example.com` — только к поддоменам; apex добавляется отдельно. User `denyDomains`, project `web.denyDomains`, запрет операции и полное отключение Web имеют приоритет над Allow, allowDomains, grants, `--allow` и Bypass. Accept edits не переопределяет явный Ask; Dont Ask разрешает действующий Allow и отклоняет всё, что потребовало бы approval. Project `.chiselrc` может только ограничивать доступ; клонированный репозиторий не может расширить пользовательские разрешения.

При Fetch Allow публичный redirect на другой hostname не требует подтверждения, но destination заново проверяется по DNS/SSRF и deny rules. При Fetch Ask другой hostname требует действующего grant; разрешение начального URL не распространяется на весь интернет. Deny повторно проверяется перед соединением и использованием кешированного final URL. Permission policy и проверка безопасных адресов — разные уровни.

## Что видит агент и чат

`web_search` возвращает до 10 компактных title/URL/domain/snippet с domain filters. Агенту предписано предпочитать официальные источники, открывать важные результаты через fetch и ссылаться на фактические final URLs. Snippet сам по себе не считается подтверждением факта.

`web_fetch` читает HTML, Markdown, plain text и JSON. Удаляются scripts, navigation, footer, очевидные ads/cookie noise и hidden elements; сохраняются title, headings, paragraphs, lists, tables и code examples. JavaScript не исполняется. Title, requested/final URL, fetchedAt и contentType сохраняются в session metadata.

В чате отображаются компактные строки: поисковый запрос и число результатов, открытый домен, title, final URL и объём извлечения. Большие документы сохраняются в закрытый artifact store с коротким preview и `tool-result://…`; агент читает нужные строки через `read_tool_result`. Resume сохраняет источники, результаты и их отображение.

Cache хранит извлечённый текст в пределах сессии: default TTL 5 минут, максимум 16 документов/2 MiB на сессию, ограниченное число активных caches. Fragment удаляется, redirect aliases используют final URL. Cache hit тоже проверяет действующие permissions. `cacheTtlMs: 0` отключает cache.

## Какие данные уходят в интернет

Выбранный сервис Exa, Parallel или Brave получает текст поискового запроса и domain filters. В Авто запрос может последовательно уйти нескольким перечисленным перед approval сервисам, если предыдущий недоступен. Exa и Parallel не получают идентификатор сессии ChiselCode, имя модели или контекст проекта. Владелец страницы получает URL fetch, обычные HTTP headers и IP соединения. Контекст проекта, исходники, cookies и login credentials автоматически не отправляются. Агент может включить данные задачи в query или URL — избегайте конфиденциальных запросов. При использовании proxy сеть проходит через настроенную пользователем корпоративную инфраструктуру.

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
chisel web test --search 'React Server Actions docs'
chisel web configure --search allow --fetch allow
chisel web configure --search ask --fetch ask
chisel web configure --disable
```

`status` не делает HTTP запросов. `test` и headless `chisel --json "Найди документацию"` используют общий ToolExecutor и действующую Web policy: с дефолтным Allow публичный Web доступен без отдельного `--allow`. При явно настроенном Ask без grant возвращаются `approval_required` и exit 2; Dont Ask отклоняет такую операцию. Явные deny и SSRF действуют во всех режимах. API errors дают controlled tool failures; локальные инструменты продолжают работать.

| Ошибка | Что сделать |
| --- | --- |
| `WEB_SEARCH_NOT_CONFIGURED` | Для Brave сохраните ключ или переключитесь на Авто / Exa / Parallel без ключа |
| `WEB_NETWORK_CONFIGURATION` | Проверьте proxy, CA и mTLS: [корпоративная сеть](network.md) |
| `WEB_NETWORK_DENIED` | Проверьте user/project deny, отключение Web и Ask/Allow/Deny; approval и Bypass не переопределяют deny |
| `WEB_UNSAFE_ADDRESS` | Используйте публичную документацию; private/metadata адреса не поддерживаются |
| `WEB_TIMEOUT`, `WEB_FETCH_FAILED` | Проверьте публичную доступность сервера и сетевые ограничения |
| `WEB_HTTP_ERROR` | Сервер вернул HTTP error; 401/403/login flows автоматически не обходятся |
| `WEB_TOO_LARGE` | Выберите меньшую страницу или конкретный текстовый endpoint |
| `WEB_REDIRECT_LIMIT` | Проверьте исходный URL и цепочку redirect |
| `WEB_UNSUPPORTED_CONTENT` | Нужен текстовый документ; PDF, binaries и JS-only/login страницы не поддерживаются |
| `WEB_RATE_LIMITED`, `WEB_REQUEST_LIMIT` | Продолжите с собранными источниками, повторите позже или выберите собственный Brave; лимиты Exa/Parallel/Brave учитываются отдельно |
| `WEB_PROTOCOL_ERROR` | Ответ сервера повреждён/оборван или backend вернул неверный JSON |

Fetch не запускает Chromium, Playwright, login forms или JavaScript. Корпоративные HTTP/HTTPS proxy, дополнительные CA и scoped mTLS поддерживаются: [настройка](network.md). Web использует CONNECT к проверенному IP, а не доверяет proxy повторное разрешение model-selected hostname. Proxy, допускающий CONNECT только к именам хостов, должен разрешить проверенные публичные IP; небезопасного fallback с повторным DNS нет. SOCKS, NTLM/Kerberos и PDF не поддерживаются.
