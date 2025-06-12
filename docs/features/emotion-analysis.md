# 感情分析機能

Discord AI Voice Botの感情分析機能は、日本語のテキストから感情を検出し、感情値を数値化する機能です。

## 概要

この機能は、以下の2つの場面で自動的に動作します：

1. **入力データの感情分析**: ユーザーの音声をテキストに変換した際
2. **出力データの感情分析**: AIが応答を生成した際

## サポートされる感情

感情分析は以下の7つのカテゴリーで感情を分類します：

- **喜び (joy)**: 嬉しい、楽しい、幸せなどの感情
- **悲しみ (sadness)**: 悲しい、つらい、寂しいなどの感情  
- **怒り (anger)**: むかつく、イライラ、腹が立つなどの感情
- **恐れ (fear)**: 怖い、不安、心配などの感情
- **驚き (surprise)**: びっくり、意外、まさかなどの感情
- **嫌悪 (disgust)**: 気持ち悪い、嫌、最悪などの感情
- **中性 (neutral)**: 特定の感情が検出されない状態

## 返される感情データ

感情分析は以下の構造の辞書を返します：

```python
{
    'joy': 0.8,           # 喜びの感情値 (0.0-1.0)
    'sadness': 0.0,       # 悲しみの感情値 (0.0-1.0)
    'anger': 0.0,         # 怒りの感情値 (0.0-1.0)
    'fear': 0.0,          # 恐れの感情値 (0.0-1.0)
    'surprise': 0.0,      # 驚きの感情値 (0.0-1.0)
    'disgust': 0.0,       # 嫌悪の感情値 (0.0-1.0)
    'neutral': 0.2,       # 中性の感情値 (0.0-1.0)
    'dominant_emotion': 'joy'  # 最も強い感情
}
```

## API関数

### 主要な関数

#### `analyze_emotion(text)`
日本語テキストから感情値を分析します。

**パラメータ:**
- `text` (str): 分析対象のテキスト

**戻り値:**
- `dict`: 感情値の辞書

**例:**
```python
from src.bot.services.ai_service import analyze_emotion

result = analyze_emotion("今日はとても楽しい一日でした！")
print(result['dominant_emotion'])  # 'joy'
print(result['joy'])  # 1.0
```

#### `get_emotion_intensity(emotion_data)`
感情データから感情の強度を計算します。

**パラメータ:**
- `emotion_data` (dict): `analyze_emotion()`の戻り値

**戻り値:**
- `float`: 感情の強度 (0.0-1.0)、中性の場合は0.0

#### `format_emotion_result(emotion_data)`
感情分析結果を読みやすい形式でフォーマットします。

**パラメータ:**
- `emotion_data` (dict): `analyze_emotion()`の戻り値

**戻り値:**
- `str`: フォーマットされた感情分析結果

**例:**
```python
result = analyze_emotion("本当にむかつく！")
formatted = format_emotion_result(result)
print(formatted)  # "感情: 強い怒り (強度: 0.54)"
```

### 変更されたAPI

既存のAI関数は感情分析機能を含むように拡張されました：

#### `transcribe_audio(audio_file_path)`
音声ファイルをテキストに変換し、感情分析を行います。

**戻り値:**
```python
{
    'text': '認識されたテキスト',
    'emotion': {感情分析結果}
}
```

#### `get_ai_response(text, history=None, system_prompt=None, channel=None)`
AIアシスタントからの応答を取得し、感情分析を行います。

**戻り値:**
```python
{
    'text': 'AI応答テキスト',
    'emotion': {感情分析結果}
}
```

### 後方互換性

既存のコードとの互換性を保つため、以下の関数も提供されます：

- `transcribe_audio_legacy()`: テキストのみを返すレガシー版
- `get_ai_response_legacy()`: テキストのみを返すレガシー版

## 使用例

### 基本的な感情分析

```python
from src.bot.services.ai_service import analyze_emotion, format_emotion_result

# テキストの感情を分析
text = "今日は悲しい出来事がありました"
emotion = analyze_emotion(text)

print(f"優勢な感情: {emotion['dominant_emotion']}")
print(f"悲しみの強度: {emotion['sadness']}")
print(f"フォーマット済み: {format_emotion_result(emotion)}")
```

### AI応答での感情分析

```python
# AI応答を取得（感情分析付き）
response = await get_ai_response("元気ですか？")
print(f"AI応答: {response['text']}")
print(f"AIの感情: {response['emotion']['dominant_emotion']}")
```

### 音声認識での感情分析

```python
# 音声認識を実行（感情分析付き）
result = await transcribe_audio("audio_file.wav")
print(f"認識テキスト: {result['text']}")
print(f"ユーザーの感情: {format_emotion_result(result['emotion'])}")
```

## 技術詳細

### 感情検出アルゴリズム

1. **キーワードベース分析**: 日本語の感情表現キーワードの辞書を使用
2. **重み付けスコアリング**: 長いキーワードほど高い信頼性スコアを付与
3. **正規化**: すべての感情値を0.0-1.0の範囲に正規化
4. **優勢感情決定**: 最も高いスコアを持つ感情を優勢感情として決定

### キーワード辞書

各感情カテゴリーには、日本語の感情表現を含む包括的なキーワード辞書があります：

- **喜び**: うれしい、楽しい、幸せ、最高、ありがとう、etc.
- **悲しみ**: 悲しい、つらい、寂しい、落ち込む、残念、etc.
- **怒り**: むかつく、イライラ、腹が立つ、許せない、etc.
- **恐れ**: 怖い、不安、心配、危険、やばい、etc.
- **驚き**: びっくり、意外、まさか、すごい、本当、etc.
- **嫌悪**: きもい、気持ち悪い、嫌、最悪、汚い、etc.

## ログ出力

感情分析が実行されると、以下のログが出力されます：

```
音声認識結果: 今日は楽しい一日でした
感情分析結果: 感情: 喜び (強度: 1.00)
AI応答: それは良かったですね！
AI応答の感情分析結果: 感情: 喜び (強度: 0.75)
```

この機能により、ボットは感情を理解し、より自然で感情に配慮した応答を提供できるようになります。