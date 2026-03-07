require('dotenv').config();
const mysql = require('mysql2/promise');
const { runAdvancedSearch } = require('./utils/searchHelper');

async function test() {
    // Use the remote host assuming it's sql211.infinityfree.com or whatever hostinger uses.
    // Wait, I don't know the exact remote DB_HOST.
    // Let me just import searchHelper and mock the db module.
    const dbModule = require('./config/database');
    console.log("Connecting to database using config:", {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        database: process.env.DB_NAME,
    });

    try {
        const parsed = { q: "Developer", limit: 20, skip: 0 };
        const res = await runAdvancedSearch(parsed);
        console.log("Success:", res);
    } catch (err) {
        console.error("Database Error:", err.message);
        if (err.sqlMessage) console.error("SQL Message:", err.sqlMessage);
        if (err.sql) console.error("SQL Query:", err.sql);
    }
    process.exit();
}

test();
