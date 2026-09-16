// config.js
const firebaseConfig = {
  apiKey: "AIzaSyDSI5tSAKvDeSXlT0ez3lv98vOcq-DlrmE",
  authDomain: "myavalon-d1c3a.firebaseapp.com",
  databaseURL: "https://myavalon-d1c3a-default-rtdb.firebaseio.com",
  projectId: "myavalon-d1c3a",
  storageBucket: "myavalon-d1c3a.firebasestorage.app",
  messagingSenderId: "974314177774",
  appId: "1:974314177774:web:625f22956117cdc9f29fff",
  measurementId: "G-3503TJXX0W"
};

// Firebase 초기화
firebase.initializeApp(firebaseConfig);
window.database = firebase.database();

window.didyou = "hmgdataasset3464";
