# Novel Studio V2.0 数据模型

## 核心实体

### books

```js
{
  id,
  title,
  intro,
  coverColor,
  createdAt,
  updatedAt,
  currentVolumeId,
  currentArcId,
  currentChapterId
}
```

### volumes

```js
{
  id,
  bookId,
  title,
  order,
  summary,
  goal,
  conflict,
  climax,
  ending,
  status
}
```

### arcs

```js
{
  id,
  bookId,
  volumeId,
  title,
  order,
  summary,
  goal,
  conflict,
  resolution,
  chapterStart,
  chapterEnd,
  status
}
```

### chapters

保留现有字段，并增加：

```js
{
  id,
  bookId,
  arcId,
  title,
  content,
  order,
  summary,
  purpose,
  status,
  wordCount,
  timelineStart,
  timelineEnd,
  updatedAt
}
```

### characters

```js
{
  id,
  bookId,
  name,
  aliases,
  identity,
  personality,
  background,
  appearance,
  goals,
  secrets,
  currentLocationId,
  currentFactionId,
  currentPower,
  status,
  relationships,
  arc,
  lastUpdatedChapterId
}
```

### locations

```js
{
  id,
  bookId,
  name,
  description,
  rules,
  parentId,
  currentState
}
```

### factions

```js
{
  id,
  bookId,
  name,
  description,
  goals,
  resources,
  leaders,
  enemies,
  allies,
  status
}
```

### timelineEvents

```js
{
  id,
  bookId,
  chapterId,
  time,
  title,
  description,
  locationId,
  characterIds,
  factionIds,
  consequences
}
```

### foreshadowing

```js
{
  id,
  bookId,
  title,
  content,
  firstChapterId,
  expectedRevealChapterId,
  relatedCharacterIds,
  relatedEventIds,
  status,
  revealMeaning
}
```

status 建议：

```text
planted
developing
revealed
resolved
abandoned
```

### worldRules

```js
{
  id,
  bookId,
  category,
  title,
  rule,
  priority,
  exceptions
}
```

### generationRuns

```js
{
  id,
  bookId,
  chapterId,
  action,
  provider,
  model,
  inputTokens,
  outputTokens,
  duration,
  status,
  createdAt
}
```

### chapterVersions

```js
{
  id,
  chapterId,
  content,
  source,
  generationRunId,
  createdAt
}
```

## 数据迁移

旧版本必须保持兼容。

旧：

```text
outlines:type=outline
outlines:type=character
outlines:type=world
```

不要立即删除。

V2 第一次启动：

```text
旧 outlines
 ↓
migration
 ↓
worldRules / characters / volumes 等候选实体
```

迁移只新增，不破坏原始数据。

建议增加：

```text
schemaVersion
```

例如：

```js
{
  schemaVersion: 2
}
```
