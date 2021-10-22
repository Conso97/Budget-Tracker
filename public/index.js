let transactions = [];
let myChart;
let hasOutstanding = false;

initIndexedDB()
.then((data) => {
  transactions = data.sort((a,b) => new Date(b.date) - new Date(a.date));
  populateChart();
  populateTable();
  populateTotal();

  return getSavedTransactions(true);
}).then((outstanding) => hasOutstanding = outstanding.length > 0);

function populateTotal() {
  // reduce transaction amounts to a single total value
  let total = transactions.reduce((total, t) => {
    return total + parseInt(t.value);
  }, 0);

  let totalEl = document.querySelector("#total");
  totalEl.textContent = total;
}

function populateTable() {
  let tbody = document.querySelector("#tbody");
  tbody.innerHTML = "";

  transactions.forEach(transaction => {
    // create and populate a table row
    let tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${transaction.name}</td>
      <td>${transaction.value}</td>
    `;

    tbody.appendChild(tr);
  });
}

function populateChart() {
  // copy array and reverse it
  let reversed = transactions.slice().reverse();
  let sum = 0;

  // create date labels for chart
  let labels = reversed.map(t => {
    let date = new Date(t.date);
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  });

  // create incremental values for chart
  let data = reversed.map(t => {
    sum += parseInt(t.value);
    return sum;
  });

  // remove old chart if it exists
  if (myChart) {
    myChart.destroy();
  }

  let ctx = document.getElementById("myChart").getContext("2d");

  myChart = new Chart(ctx, {
    type: 'line',
      data: {
        labels,
        datasets: [{
            label: "Total Over Time",
            fill: true,
            backgroundColor: "#6666ff",
            data
        }]
    }
  });
}

function sendTransaction(isAdding) {
  let nameEl = document.querySelector("#t-name");
  let amountEl = document.querySelector("#t-amount");
  let errorEl = document.querySelector(".form .error");

  // validate form
  if (nameEl.value === "" || amountEl.value === "") {
    errorEl.textContent = "Missing Information";
    return;
  }
  else {
    errorEl.textContent = "";
  }

  // create record
  let transaction = {
    name: nameEl.value,
    value: amountEl.value,
    date: new Date().toISOString()
  };

  // if subtracting funds, convert amount to negative number
  if (!isAdding) {
    transaction.value *= -1;
  }

  // TODO: add to db and unshift on success
  var isOutstanding = false; // we don't know yet if sending to the server will fail
  saveRecords([transaction], isOutstanding).
  then((data) => {

    // add to beginning of current array of data
    transactions.unshift(transaction);

    // re-run logic to populate ui with new record
    populateChart();
    populateTable();
    populateTotal();
  });
  
  // also send to server
  fetch("/api/transaction", {
    method: "POST",
    body: JSON.stringify(transaction),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  })
  .then(response => {    
    return response.json();
  })
  .then(data => {
    if (data.errors) {
      errorEl.textContent = "Missing Information";
    }
    else {
      // clear form
      nameEl.value = "";
      amountEl.value = "";
    }
  })
  .catch(err => {
    // fetch failed, so save in indexed db
    isOutstanding = true;
    saveRecords([transaction], isOutstanding)
    .then((data) => {
      // clear form
      nameEl.value = "";
      amountEl.value = "";
    });

    
  });
}

function saveRecords(transactionsToSave, isOutstanding) {

  // add to unresolved transactions
  return new Promise (function(resolve) {
    const request = window.indexedDB.open("database", 1);
    request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(
            [ "all-transactions", "outstanding-transactions" ],
            "readwrite"
        );
        const transactionStore = transaction.objectStore("all-transactions");
        const outstandingStore = transaction.objectStore("outstanding-transactions");
      
        // Add data
        for (var i = 0; i < transactionsToSave.length; i++) {
          transactionToSave = transactionsToSave[i];
          if (isOutstanding) {
            outstandingStore.add({name: transactionToSave.name, 
              value: transactionToSave.value, date: transactionToSave.date});
              hasOutstanding = true;
          } else {
            transactionStore.add({name: transactionToSave.name, 
              value: transactionToSave.value, date: transactionToSave.date});
          }
        }

        // Clean up: close connection
        transaction.oncomplete = () => {
            db.close();
            console.log("done saving");
            return resolve(transactionsToSave);
        };
    };
  });
}


function getSavedTransactions(isOutstanding) {
  return new Promise (function(resolve) {
    var savedTransactions = [];
    const request = window.indexedDB.open("database", 1);
    request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(
            [ "all-transactions", "outstanding-transactions" ],
            "readwrite"
        );
        const transactionStore = transaction.objectStore("all-transactions");
        const outstandingStore = transaction.objectStore("outstanding-transactions");
      
        var req  = null;
        if (isOutstanding) {
          req = outstandingStore.openCursor();
        } else {
          req = transactionStore.openCursor();
        }

        req.onerror = function(event) {
          console.err("error fetching data");
        };
        req.onsuccess = function(event) {
            let cursor = event.target.result;
            if (cursor) {
                let value = cursor.value;
                savedTransactions.unshift(value);

                cursor.continue();
            }
            else {
                // no more results
            }
        };
        
        // Clean up: close connection
        transaction.oncomplete = () => {
            db.close();
            return resolve(savedTransactions);
        };
    };
  });
}
// flow: ping server for transactions and populate into db if on init
// query db for data to populate
// on new transaction, add to db and send to server
// if send to server fails, then add to outstandind db
// periodically try to send bulk to server (if connection exists); once succeeded, remove from outstanding db

var intervalId = setInterval(function() {
  retrySave();
}, 1000);

function retrySave() {

  // try to save if there is connection and outstanding transactions
  if (navigator.onLine && hasOutstanding) {
    var isOutstanding = true;
    getSavedTransactions(isOutstanding)
    .then((outstandingTransactions) => {
      return fetch("/api/transaction/bulk", {

        method: "POST",
        body: JSON.stringify(outstandingTransactions),
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json"
        }
      });
    })
    .then(response => { 
      // if succeeded, remove outstanding from db   
      clearOutstanding();
    })
  }

}

function clearOutstanding() {
  const request = window.indexedDB.open("database", 1);
  request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(
          [ "outstanding-transactions" ],
          "readwrite"
      );
      const outstandingStore = transaction.objectStore("outstanding-transactions");
      var clearReq = outstandingStore.clear();
      
      clearReq.onsuccess = function(event) {
        // report no more outstanding on success
        hasOutstanding = false;
      };
      
      // Clean up: close connection
      transaction.oncomplete = () => {
          db.close();
      };
  };
}

function initIndexedDB() {

  return new Promise (function(resolve) {

    if(document.cookie.indexOf('mycookie')==-1) {
      document.cookie = 'mycookie=1';

      // create on first page load and fill with data from server
      const request = window.indexedDB.open("database", 1);
      // Create schema
      request.onupgradeneeded = event => {
          const db = event.target.result;
          
          const transactionStore = db.createObjectStore(
              "all-transactions",
              { keyPath: "name" }
          );
          const outstandingStore = db.createObjectStore(
              "outstanding-transactions",
              { keyPath: [ "name" ] }
          );
      };

      request.onsuccess = function(event) {
        // get data from server
        return resolve(fetchDataFromServer());
      };
    } else {
      // otherwise, use cache
      var isOutstanding = false; // load saved data
      return resolve(getSavedTransactions(isOutstanding));
    }
  });
  
}

function fetchDataFromServer() {
  
  return fetch("/api/transaction")
  .then(response => {
    return response.json();
  })
  .then(data => {
    // save data to indexed DB
    const isOutstanding = false; // these are already save on the server
    return saveRecords(data, isOutstanding);

  }).then((data) => {
    transactions = data;
    console.log(transactions);
    return data;
  });
}

document.querySelector("#add-btn").onclick = function() {
  sendTransaction(true);
};

document.querySelector("#sub-btn").onclick = function() {
  sendTransaction(false);
};

// https://levelup.gitconnected.com/detecting-online-offline-in-javascript-1963c4fb81e1
// register function to run every millisecond if connection is online & db has 
// outstanding transactions
//  if so, send bulk transactions. on success, remove outstanding transactions

// corner case: make transaction offline and refresh -> make sure all transactions are saved to 
// indexedDB and a separate table is used for unresolved ones