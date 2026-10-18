# Bake Viewer — перепечка base color (high → low)

Веб-инструмент: загружаешь low/high poly, он пекёт base color методом
**Selected to Active (EMIT)** в Blender, показывает low-poly модель в браузере
(Three.js) и даёт цветокорректировать base color с живым предпросмотром и
экспортом в PNG.

## Возможности

- Импорт low / high poly (`.fbx`, `.obj`, `.glb`, `.gltf`, `.stl`) и опционально
  своей base color текстуры.
- Бейк в Blender headless (Cycles, EMIT + Selected to Active) — параметры
  `cage_extrusion`, `max_ray_distance`, `margin`, `resolution`.
- Просмотр low-poly (Three.js), опорная сетка и каркас с выбором цвета.
- Превью кейджа как в Substance Painter: полупрозрачная оболочка (low-poly,
  раздутый вдоль нормалей на `cage_extrusion`) с настройкой прозрачности,
  цвета, каркаса; обновляется в реальном времени при движении ползунка.
- Цветокоррекция base color: яркость, контраст, насыщенность, hue, vibrance,
  экспозиция, гамма, температура, тон, уровни, резкость — живой предпросмотр
  на GPU.
- Сохранение результата на сервере (`POST /save-texture`) и скачивание PNG.

## Требования

- Windows
- Blender 5.0 (путь см. ниже)
- Python 3 (для сервера; используется только стандартная библиотека)
- GPU желателен (Cycles + OPTIX), иначе автоматический откат на CPU

## Запуск

1. `start.bat` — поднимает сервер на http://127.0.0.1:8765 и открывает браузер.
   Вручную: `python server.py`.
2. Порт меняется через переменную окружения `BAKE_PORT` (по умолчанию `8765`).

## Конфигурация

Пути пока захардкожены в `server.py` и `export_glb.py`:

- `BLENDER` — путь к `blender.exe`
- `BASE` — рабочая папка (сюда пишется `l_basecolor.png`, здесь лежат аплоады)

Их нужно поправить под свою машину. (TODO: вынести в env/конфиг.)

## Как это работает

- `server.py` — HTTP-сервер: раздаёт `web/`, эндпоинты `POST /bake` (multipart),
  `POST /save-texture`, `GET /texture.png`. Запускает беик через Blender в
  отдельном процессе.
- `bake_web.py` — Blender-скрипт: импорт моделей, бейк EMIT+Selected to Active,
  экспорт low-poly в GLB.
- `export_glb.py` — вспомогательный скрипт: только экспорт low-poly в GLB (без бейка).
- `web/` — фронтенд (Three.js вендорен в `web/three.module.js` + `web/jsm/`).

## В git не попадает (см. `.gitignore`)

- `uploads/` — загруженные модели
- `bake_scene.blend` — кэш сцены Blender
- `web/model.glb` — генерируется при бейке

## Стек

- Blender 5.0 (Cycles, Selected to Active bake, Emission)
- Python 3 (`http.server`)
- Three.js r160 (вендоренный)
