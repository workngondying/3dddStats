# SiteStat GitHub Pages

Проект переделан под полностью статический запуск через GitHub Pages и GitHub Actions.

## Что где лежит

- `public/` - сам сайт для GitHub Pages
- `public/data/site-data.json` - готовые данные для фронтенда
- `data/snapshots.json` - ежедневная история
- `data/details-cache.json` - кэш категорий и дат публикации
- `.github/workflows/pages.yml` - ежедневный сбор и деплой

## Локально

```bash
npm install
node scripts/collect.js
node scripts/build-static-data.js
```

После этого сайт можно открыть через любой статический сервер из папки `public`.

## Как запустить бесплатно на GitHub Pages

1. Создайте новый репозиторий на GitHub.
2. Загрузите в него все файлы из этой папки.
3. Откройте `Settings -> Pages`.
4. В `Source` выберите `GitHub Actions`.
5. Откройте вкладку `Actions` и вручную запустите workflow `Build And Deploy`.

После первого запуска:

- сайт будет опубликован через GitHub Pages
- workflow будет каждый день собирать новый срез
- история будет сохраняться в `data/snapshots.json`
- фронтенд будет автоматически обновляться
- категории и даты публикации будут дозаполняться постепенно, чтобы ежедневный workflow не зависал слишком долго

## Важно

- GitHub Actions в этом проекте заменяет сервер
- данные собираются по расписанию в workflow
- если хотите поменять время ежедневного сбора, измените `cron` в `.github/workflows/pages.yml`
