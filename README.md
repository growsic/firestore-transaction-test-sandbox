# Firestore トランザクション検証環境

## 概要について
このプロジェクトはFirestoreの悲観ロックの挙動を確認するためのテストである。
N枚のチケットを購入するためにM人のユーザーが殺到するケースを想定し、トランザクション制御の挙動を検証する。

## Firestoreの悲観ロックの挙動について
結論から言うとFirestoreの悲観ロックは本質的には楽観ロックの挙動をする。トランザクションを開始した後にレコードを取得するとレコードに対してロックがかかるが、これは読み取りを制限するものではなく、他のトランザクションによる更新をブロックするのみにとどまる。すなわち複数のトランザクションが同時にアクセスすると、同じチケットを購入可能とみなして処理を進め、単一のチケットを複数のトランザクションが更新しようとしにいってしまう。更新処理をしようとした時にロック獲得待ちを行い、更新しようとした時にレコードが更新されていることを検知しトランザクションが再実行される。同時実行が多い場合だとリトライが繰り返され、10回リトライしたところでタイムアウトになる。MySQLなどでselect for updateで読み取りロックをかけ順次制御を行うことができる挙動と大きく異なる。

これはFirestoreがスケーラビリティを優先して設計されたデータベースだからであり、実行コストのかかる読み取りのロックは行っていないことに起因する。読み取りを含めた順序制御をFirestoreのデータベースの機能で実現することは難しく、自前の順序制御の実装が必要になる。

## Firestoreでの順序処理の実現方法について
自前のキューイングの仕組みを実装するのが実装コスト低くできる方法になる。キューイング用のコレクションを用意し、定期的にポーリングして自分の番が回ってくるのを待つ。

このプロジェクトでは`que`コレクションを作成し、`addTransactionQueue`、`deleteTransactionQueue`、`isMinExpiresAt`、`waitForTurn`関数でキューイングを実装している。自前でポーリング処理を書くことになるため、間隔をどのくらいにするか、リトライ回数の上限をどれくらいにするか、意図せず破棄されなかったキューをどう無視するかを丁寧に設計する必要がある。リトライ期間が短すぎるとタイムアウトする可能性が高くなり、長くしすぎると順序処理の処理速度が大きく低下してしまう。

## 今回のテストコードについて

### プロジェクト構成
本プロジェクトはDockerを使用してFirestore Emulatorとテストアプリケーションをコンテナとして構築している。

#### インフラストラクチャ
- Firestore Emulatorコンテナ (ポート8080でFirestoreをエミュレート)
- テストアプリケーションコンテナ (Node.js実装)

#### アプリケーション構成
テストアプリケーションは以下のコレクションと機能で構成している:

**Firestoreコレクション:**
- `tickets`: チケット情報を管理するコレクション
- `que`: 順序制御のためのキューイング用コレクション

**主要機能:**
- トランザクション実行制御
- キューイング制御
- テストシナリオ実行 (`testTransactions`関数)

### テスト実行パラメータ
`testTransactions`関数は以下の引数で動作をカスタマイズできる:
- transactionType: トランザクションの種類("runTransaction"固定)
- useQueue: キューイングを使用するかどうか(true/false)
- numTickets: テストで使用するチケット数(デフォルト30枚)
- concurrentUserCount: 同時アクセスユーザー数(デフォルト50人)

## 実行方法について
1. `docker-compose build` でイメージをビルド
2. `docker-compose up` でコンテナを起動
3. index.jsの最下部にある`testTransactions`関数の引数を必要に応じて調整
4. `docker-compose run app node /wkspace/index.js`を実行
4. コンソールに出力される実行結果を確認

## ログの内容について
実行結果のログには以下のような情報が出力される:
### 各トランザクション更新の処理
トランザクションのリトライ回数、トランザクション内で取得したレコード等の情報が出力される。
トランザクション内での取得(悲観ロック)で取得しているため、キューを使わないで実行した場合は複数のトランザクションが同一のレコードを参照していることがわかる。
```
[Transaction 1] Transaction attempt #1 started.
[Transaction 1] { ticket_id: 1, ticket_rank: 1, owner_id: 0, is_sold: false }
[Transaction 1] Ticket updated successfully.
[Transaction 1] Transaction took 184ms
```

### 処理結果
トランザクションを一斉に走らせた結果、チケットの購入状態がどうなったか出力される。
パラメータを変えて実行することで、Failed Transactionsの数や理由が変動する。
キューを使わずに大量に並行して処理したり、キューのリトライの設定が短すぎるとタイムアウトになるケースが多発する。

トランザクションごとのチケット購入(更新処理)の成功有無
```
Successful Transactions: [
  { label: 'Transaction 1', ticketId: '1', retries: 1 },
  { label: 'Transaction 3', ticketId: '4', retries: 2 },
  { label: 'Transaction 4', ticketId: '3', retries: 2 },
  { label: 'Transaction 7', ticketId: '5', retries: 2 },
  { label: 'Transaction 10', ticketId: '2', retries: 1 }
]
Failed Transactions: [
  { label: 'Transaction 2', reason: 'No tickets available' },
  { label: 'Transaction 5', reason: 'No tickets available' },
  { label: 'Transaction 6', reason: 'No tickets available' },
  { label: 'Transaction 8', reason: 'No tickets available' },
  { label: 'Transaction 9', reason: 'No tickets available' }
]
```
チケットの最終の更新結果
```
Final state of tickets:
{
  ticket_id: 1,
  ticket_rank: 1,
  is_sold: true,
  owner_id: 'Transaction 1'
}
{
  ticket_id: 2,
  ticket_rank: 1,
  is_sold: true,
  owner_id: 'Transaction 10'
}
```

## useQueueをfalseにした場合
Firestoreとしての悲観ロック(実質的には楽観ロック)を使用しながら、複数のトランザクションが同時にチケットを購入しようとして処理を実行する。クエリ結果を見るとわかるが、複数のトランザクションが同じレコードを更新しようと取り合い、何度もトランザクションのリトライが発生する。同時実行のユーザー数が多いと、チケットが残っているにもかかわらずタイムアウトになるケースが多発する。

## useQueueをtrueにした場合
キュー用のコレクションに自身を登録し、実行後に削除するシンプルなキューを用意している。一定間隔でポーリングし、自分の番が来ると処理を開始する。順序処理になるため1つずつ処理されていくが、ポーリング間隔を長くすると処理時間が非常に長くなる。短くするとリトライの上限にすぐ抵触してタイムアウトが多発してしまう様子が確認できる。

サービスにおいて同時実行数の想定件数を踏まえてこの辺りを設計することが推奨される。同時実行数の想定がかなり少ないのであれば、Firestoreの悲観ロック(実質楽観ロック)の仕組みに準じた、自動リトライでの復旧を前提とした仕組みで十分かもしれない。