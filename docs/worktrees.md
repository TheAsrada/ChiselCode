# Изолированные рабочие копии

`/worktree` управляет отдельными detached Git worktrees. Они живут в ChiselCode Home вне проекта. Новые ветки не создаются; закрытие вкладки, Ctrl+C и shutdown не удаляют копию. Для этого нужен обычный non-bare Git repository с committed HEAD и Git 2.39+. Fetch, установка зависимостей, stash, reset и автоматические commits не выполняются.

## Начать две задачи

В TUI используйте:

```text
/worktree create Первая задача
/worktree create Вторая задача
/worktree list
/worktree open <ID первой копии>
```

Create проходит обычное подтверждение Git mutation. Base по умолчанию — committed HEAD основного проекта; `/worktree create --ref <local-ref> <название>` выбирает другой уже существующий commit. Незакоммиченные файлы основного проекта не копируются и не изменяются. Команда показывает UUID, label, base и полный путь. `open` проверяет ownership/Git identity и открывает новую conversation/tab по этому root. В sidebar видны label/ID и Detached HEAD. В CLI `open` выводит проверенный путь для обычного `chisel --cwd <path> "задача"`.

В каждой копии работают обычные агент, manifest, read/edit, Git, shell, LSP, Settings и `/btw`. Session, observations, LSP documents, drafts и файлы принадлежат своему root. Global credentials не копируются в repository. Можно менять одинаковый путь в двух задачах независимо. Обычные file tools разных roots выполняются параллельно; shell calls одного Git repository консервативно сериализуются, поскольку shell может менять общие refs/config.

## Посмотреть и применить

```text
/worktree status <ID>
/worktree diff <ID>
/worktree apply <ID>
```

Result сравнивает итоговые файлы с immutable base, включая commits, staged/unstaged edits и допустимые untracked files. `diff` использует штатные diff cards; применение показывает выбранные changes и origin target в approval. Для поддержанного subset: `/worktree diff <ID> <path>` и `/worktree apply <ID> <path>`. Хвост path буквальный, может содержать пробелы; кавычки не являются shell quoting. Model tool input допускает массив `paths`.

Target — только записанный origin этого дерева. Если target равен base, перенос разрешён; если уже равен source, это no-op. Отличается от обоих — conflict до записи. Staged/conflicted target paths блокируют перенос; остальные dirty/staged файлы сохраняются. HEAD, branch, index target и source не меняются. После preview identity, HEAD/index, bytes и политика перепроверяются; изменения дают stale error и требуют нового diff/approval.

Transfer поддерживает regular UTF-8 text create/edit/delete, сохраняет bytes/line endings результата и обычный Git file mode. Binary, symlinks, executable/mode-only changes, gitlinks, invalid encoding, Windows case collisions и unsafe paths не переносятся. Ignored/запрещённое содержимое не читается ради diff; unsupported item блокирует весь выбранный набор. Лимиты: 512000 bytes/file, 8 MiB base+result bytes, 200 selected files, 20000 metadata paths, 1000 registry records. Rename представлен безопасным delete+add; автоматического merge/cherry-pick нет.

## Закрыть, вернуться, удалить

Закройте вкладку обычным Ctrl+W и позже снова `/worktree open <ID>`. Неактивная вкладка тоже удерживает use lease. Удаление отдельное:

```text
/worktree remove <ID>
```

Нет force/discard. Dirty, staged, conflicted, untracked **и ignored** файлы (включая node_modules/cache), Git locks, unfinished intent и живые пользователи блокируют удаление. Очистка файлов — отдельное осознанное действие, а не часть remove. External worktrees и origin показываются read-only и не удаляются.

Clean дерево с HEAD != base содержит commit-result. Перед remove он удерживается в `refs/chiselcode/worktrees/<ID>/<OID>`; это internal ref, не branch. Ref и OID показываются в результате/list после restart. `git show <ref>` читает сохранённый result; для новой detached копии можно явно выполнить обычный Git `worktree add --detach <новый-путь> <ref>`. Ref не удаляется автоматически по timeout и переживает Git GC. Ошибка retention блокирует remove.

Registry schema 1 находится в `ChiselCode Home/worktrees/<repository-hash>/registry.json`; managed trees и owner heartbeats — рядом. После незавершённого create/remove/apply list/status сверяют directory, Git registration, immutable ownership и hashes. Не выполняют mutation replay, global prune/repair/unlock или автоматический rollback. Частичный/неизвестный apply получает «Нужна проверка»: inspect paths и сохранённые Session tool checkpoints перед явным восстановлением. Повреждённый JSON сохраняется. Multi-file apply использует обычный EditingService rollback при error/abort, но не обещает crash-atomicity; concurrent bytes не перезаписываются ради rollback.

Worktree — файловая изоляция, не OS sandbox. Git common metadata остаются общими, shell/server работают с правами пользователя, внешние editors/Git не подчиняются core leases. Subagents, jobs и автоматическое применение/удаление здесь не добавлены. Bare/unborn repositories, submodules, sparse checkout и external checkout filters/LFS пока unsupported. Missing Git не ломает остальные функции приложения. `/help` не возвращён.
