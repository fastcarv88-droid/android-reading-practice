# Kokoro 依赖安装与模型下载记录

2026-10-06，用户明确批准安装依赖并下载模型，并跳过三句试听环节。本次安装和下载已完成；未生成或替换正式音频，未上传GitHub。

独立环境：E:\lq\verification-work\kokoro-venv
模型目录：E:\lq\verification-work\kokoro-model

已安装：Python 3.11.9、PyTorch 2.14.1+cpu、Kokoro 0.9.4、Misaki 0.9.4（含中文处理依赖）、SoundFile 0.14.0、Transformers 4.57.6。完整实际依赖版本保存在模型目录 requirements-installed.txt。

pip check 返回 No broken requirements found。实际导入Kokoro和中文处理模块，并通过本地文件初始化KModel成功；预置女声 zf_001.pt 安全加载成功，张量尺寸510×1×256。本次未执行语音合成或人工试听；模型初始化有上游LSTM dropout提示及weight_norm弃用提示，进程正常结束。

模型：hexgrad/Kokoro-82M-v1.1-zh
固定版本：01e7505bd6a7a2ac4975463114c3a7650a9f7218
权重文件：kokoro-v1_1-zh.pth，327247856字节
SHA-256：b1d8410fa44dfb5c15471fd6c4225ea6b4e9ac7fa03c98e8bea47a9928476e2b，与官方模型卡公布值一致。
另已下载同版本config.json、README.md和voices/zf_001.pt；每个文件的校验值记录在download-record.json。

官方来源：
- https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh
- https://github.com/hexgrad/kokoro
- PyTorch CPU包：https://download.pytorch.org/whl/cpu

环境、模型与下载脚本均在项目外。网页使用者无需安装这些依赖；上传网站时只需要生成后的音频。本记录已获用户确认并提交本地Git，版本6e30d58。后续用户要求试听，三句样音生成后确认通过，并批准生成全部十句。
