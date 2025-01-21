FROM node:18

# Firebase CLIをインストール
RUN npm install -g firebase-tools

# Java (Default JRE) をインストール
RUN apt-get update && apt-get install -y default-jre-headless && apt-get clean

# 作業ディレクトリを設定
WORKDIR /workspace

# 必要なファイルをコンテナにコピー
COPY package*.json ./
RUN npm install

# 必要に応じてファイルをマウントするので、デフォルトコマンドは設定しない
