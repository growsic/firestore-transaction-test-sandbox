const admin = require("firebase-admin");


// Firestoreの初期化
admin.initializeApp({
  projectId: "firestore-docker-test",
});

const db = admin.firestore();
let acquisitionCounster = 0; // チケット取得順を管理するカウンター

async function setupTestData(numTickets = 30) {
  console.log("Initializing test data...");

  const collectionRef = db.collection("tickets");

  // 既存データ削除
  const existingDocs = await collectionRef.listDocuments();
  for (const doc of existingDocs) {
    console.log(`Deleting document: ${doc.id}`);
    await doc.delete();
  }

  // テストデータ作成
  const testData = Array.from({ length: numTickets }, (_, i) => ({
    ticket_id: i + 1,
    ticket_rank: Math.floor(i / 4) + 1, // 4枚ごとにランクが1上がる
    owner_id: 0,
    is_sold: false
  }));

  for (const ticket of testData) {
    console.log(`Adding document: ${JSON.stringify(ticket)}`);
    await collectionRef.doc(String(ticket.ticket_id)).set(ticket);
  }

  console.log("Test data initialization complete.");
}  

async function addTransactionQueue(label) {
  const EXPIRATION_TIME = 20 * 1000;
  const queueRef = db.collection("que");
  const expiresAt = Date.now() + EXPIRATION_TIME;
  await queueRef.doc(label).set({
    label,
    expiresAt
  });
}

async function deleteTransactionQueue(label) {
  const queueRef = db.collection("que");
  await queueRef.doc(label).delete();
}

async function isMinExpiresAt(label) {
  const queueRef = db.collection("que");
  const now = Date.now();
  const snapshot = await queueRef
    .where("expiresAt", ">", now)
    .orderBy("expiresAt", "asc")
    .limit(1)
    .get();

  if (!snapshot.empty) {
    const minDoc = snapshot.docs[0];
    return minDoc.data().label === label;
  }
  return false;
}

async function waitForTurn(label, maxRetries, waitTime) {
  for (let i = 0; i < maxRetries; i++) {
    if (await isMinExpiresAt(label)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  return false;
}

async function withQueue(label, fn, waitTime, maxRetries) {
  try {
    await addTransactionQueue(label);
    const canProceed = await waitForTurn(label, maxRetries, waitTime);
    if (!canProceed) {
      console.log(`[${label}] Failed to get turn after max retries`);
      return {
        success: false,
        reason: "Failed to get turn", 
        label,
        retries: 0
      };
    }
    return await fn();
  } finally {
    await deleteTransactionQueue(label);
  }
}

async function runTransaction(label, useQueue, queIntervalTime, queMaxRetries) {
  const collectionRef = db.collection("tickets");
  let retries = 0;

  const transactionFn = async () => {
    return await executeTransaction(label, collectionRef, retries);
  };

  return useQueue ? await withQueue(label, transactionFn, queIntervalTime, queMaxRetries) : await transactionFn();
}

async function executeTransaction(label, collectionRef, retries) {
  return await db
    .runTransaction(async (transaction) => {
      retries++;
      console.log(`[${label}] Transaction attempt #${retries} started.`);

      const query = collectionRef
        .where("is_sold", "==", false)
        .orderBy("ticket_rank", "asc")
        .limit(1);

      const querySnapshot = await transaction.get(query);

      if (querySnapshot.empty) {
        console.log(`[${label}] No tickets available for purchase.`);
        return {
          success: false,
          reason: "No tickets available", 
          label,
          retries
        };
      }

      const ticketDoc = querySnapshot.docs[0];
      const ticketData = ticketDoc.data();
      console.log(`[${label}]`, ticketData);

      const updatedData = {
        ...ticketData,
        is_sold: true,
        owner_id: label
      };

      transaction.update(ticketDoc.ref, updatedData);

      console.log(`[${label}] Ticket updated successfully.`);
      return {
        success: true,
        ticketId: ticketDoc.id,
        label,
        retries
      };
    })
    .catch((error) => {
      console.error(`[${label}] Transaction failed: ${error.message}`);
      return {
        success: false,
        reason: error.message,
        label,
        retries
      };
    });
}
  

async function printAllTickets() {
  const collectionRef = db.collection("tickets");
  const allDocs = await collectionRef.get();

  console.log("Final state of tickets:");
  allDocs.forEach((doc) => {
    console.log(doc.data());
  });
}

async function testTransactions(transactionType, useQueue = true, numTickets = 30, concurrentUserCount = 50, queIntervalTime = 100, queMaxRetries = 10000) {
    
    console.log(`Starting Firestore transaction test with ${transactionType}...`);
    console.log(`Test parameters: numTickets=${numTickets}, concurrentUsers=${concurrentUserCount}, useQueue=${useQueue}, queIntervalTime=${queIntervalTime}, queMaxRetries=${queMaxRetries}`);
  
    // テストデータの初期化
    await setupTestData(numTickets);
  
    // トランザクションのラベルを作成
    const transactionLabels = Array.from({ length: concurrentUserCount }, (_, i) => `Transaction ${i + 1}`);
    const testStartTime = Date.now();
    // トランザクションを100ミリ秒ごとに遅らせて実行
    const transactionPromises = transactionLabels.map((label, index) =>
      new Promise((resolve) => {
        setTimeout(() => {
          const startTime = Date.now();
          
          const promise = transactionType === "runTransaction" 
            ? runTransaction(label, useQueue, queIntervalTime, queMaxRetries)
            : transactionType === "lockRecordRunTransaction"
            ? lockRecordRunTransaction(label)
            : Promise.reject(new Error("Invalid transaction type"));

          promise.then(result => {
            const endTime = Date.now();
            console.log(`[${label}] Transaction took ${endTime - startTime}ms`);
            resolve({
              ...result,
              timestamp: {
                start: startTime,
                end: endTime,
                duration: endTime - startTime
              }
            });
          });
        }, index * 10); // 10ミリ秒の間隔
      })
    );
  
    // トランザクション結果を待機
    const results = await Promise.all(transactionPromises);
  
    // 成功と失敗のトランザクションを分ける
    const successfulTransactions = results.filter((result) => result.success);
    const failedTransactions = results.filter((result) => !result.success);
  
    console.log(`Transaction results for ${transactionType}:`);
    console.log(
      "Successful Transactions:",
      successfulTransactions.map((tx) => ({
        label: tx.label,
        ticketId: tx.ticketId,
        retries: tx.retries
      }))
    );
    console.log(
      "Failed Transactions:",
      failedTransactions.map((tx) => ({
        label: tx.label,
        reason: tx.reason
      }))
    );
  
    // 更新後の全データ出力
    await printAllTickets();

    const testEndTime = Date.now();
    console.log(`Total test duration: ${testEndTime - testStartTime}ms`);
  }
  
  // 実行: runTransaction を使用
  testTransactions(
    "runTransaction",
    useQueue = false,
    numTickets = 5,
    concurrentUserCount = 10,
    queIntervalTime = 100,
    queMaxRetries = 100
  ).catch((error) => {
    console.error("An error occurred during the test (runTransaction):", error);
  });