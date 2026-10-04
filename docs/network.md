# Корпоративная сеть

[Документация](README.md) · [Провайдеры](providers.md) · [Web](web.md)

ChiselCode поддерживает HTTP/HTTPS proxy, дополнительные сертификаты доверия и клиентские сертификаты mTLS для LLM API, удалённых HTTP MCP и native Web. Настройки задаются в окружении пользователя перед запуском; репозиторий и веб-страницы не могут устанавливать proxy или ослаблять TLS. `/settings` → Web и `chisel web status --json` показывают состояние без паролей, PEM и путей к закрытым ключам.

## Proxy в Windows Terminal

Пример для PowerShell:

```powershell
$env:HTTPS_PROXY = "http://proxy.company.example:8080"
$env:HTTP_PROXY = "http://proxy.company.example:8080"
$env:NO_PROXY = "localhost,127.0.0.1,::1,.company.example"
chisel
```

В bash/zsh:

```sh
export HTTPS_PROXY=http://proxy.company.example:8080
export HTTP_PROXY=http://proxy.company.example:8080
export NO_PROXY='localhost,127.0.0.1,::1,.company.example'
chisel
```

HTTPS-запросы выбирают `https_proxy` / `HTTPS_PROXY`, затем `http_proxy` / `HTTP_PROXY`. HTTP использует HTTP proxy. Нижний регистр имеет приоритет. `no_proxy` / `NO_PROXY` принимают разделённые запятыми или пробелами точные адреса, `.example.com`, `*.example.com`, необязательный порт, IP/CIDR и `*`. Правило `.example.com` включает сам домен; `*.example.com` — только поддомены.

Поддерживается Basic authentication в proxy URL: `http://user:password@proxy.company.example:8080`. Установите его через защищённые средства своей организации: не добавляйте пароль в `.chiselrc`, сообщения агенту, документацию или общие shell-скрипты. Proxy-авторизация передаётся только proxy при CONNECT. SOCKS, NTLM и Kerberos автоматически не включаются.

## Собственный центр сертификации

Если организация проверяет HTTPS через свой CA, добавьте PEM-сертификат доверия:

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\Certificates\company-ca.pem"
chisel
```

```sh
export NODE_EXTRA_CA_CERTS=/etc/company/company-ca.pem
chisel
```

Дополнительный CA расширяет доверие, сохраняя проверку цепочки и hostname. По умолчанию используются встроенные корни и доступные корни ОС. `CHISEL_CERT_STORE=bundled`, `system` или `bundled,system` ограничивает источники доверия; пустое хранилище без дополнительного CA вызывает ошибку. `NODE_TLS_REJECT_UNAUTHORIZED=0` не отключает проверку в этом transport.

## mTLS

Укажите сертификат клиента, его закрытый ключ и адреса, которым разрешено предлагать эту identity:

```powershell
$env:CHISEL_CLIENT_CERT = "C:\Certificates\client.pem"
$env:CHISEL_CLIENT_KEY = "C:\Certificates\client-key.pem"
$env:CHISEL_CLIENT_CERT_HOSTS = "gateway.company.example,proxy.company.example"
chisel
```

```sh
export CHISEL_CLIENT_CERT=/etc/company/client.pem
export CHISEL_CLIENT_KEY=/etc/company/client-key.pem
export CHISEL_CLIENT_CERT_HOSTS='gateway.company.example proxy.company.example'
chisel
```

Для зашифрованного PEM используйте `CHISEL_CLIENT_KEY_PASSPHRASE` из защищённого окружения. Поддерживаются точные hostname и `*.company.example`; универсальный `*` запрещён. Все три основные переменные обязательны вместе. Сертификат не предлагается произвольному публичному сайту. TLS proxy и целевого сервера настраивается независимо, включая их mTLS. После смены файлов сертификатов перезапустите приложение: PEM кешируется в памяти.

## Проверить подключение

```sh
chisel web status --json
chisel --allow web_fetch web test --url https://react.dev/reference/
chisel --allow web_search web test --search 'React Server Actions official documentation'
chisel mcp doctor
```

Разрешения продолжают действовать: наличие proxy или CA само по себе не даёт агенту доступ к интернету. В Bypass подтверждения не нужны, но явный Deny и SSRF-защита Web сохраняются.

Native Web проверяет все DNS-ответы и туннелирует CONNECT к проверенному публичному IP, сохраняя исходный Host/SNI и проверку сертификата. Это предотвращает повторное DNS-разрешение proxy в private network. Некоторые корпоративные proxy требуют hostname в CONNECT; им нужно разрешить проверенные IP на портах 80/443. ChiselCode не переключается на более слабую проверку. Private network не становится доступной через Web; локальные LLM и явно настроенные MCP имеют собственные правила доступа.

При ошибке проверьте корректность proxy URL, доступность порта, доверие к CA и hostname сертификата, пару cert/key и список mTLS-адресов. HTTP 407 означает, что proxy требует авторизацию. HTTP 403 может исходить от корпоративного фильтра или сайта; ChiselCode не обходит запрет или login. Если Exa достиг бесплатного лимита, используйте уже открытые источники, повторите позже или выберите свой Brave.
