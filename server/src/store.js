// store.js — 数据层入口：按 SLENK_DATA_BACKEND 选择后端，导出接口一致。
//
//   sqlite（默认，未设置时）→ store.sqlite.js：Node 内置 SQLite，默认 <dataDir>/slenk.sqlite
//   mysql                  → store.mysql.js：业务数据存 MySQL
//
// routes / worker / auth / lib 等一律 `import { ... } from './store.js'`，切换后端零改动。
// 非法后端值启动即抛错，避免静默落到错误数据源。
import './loadEnv.js';
import * as sqliteImpl from './store.sqlite.js';
import * as mysqlImpl from './store.mysql.js';

const backend = process.env.SLENK_DATA_BACKEND || 'sqlite';
let impl;
if (backend === 'sqlite') impl = sqliteImpl;
else if (backend === 'mysql') impl = mysqlImpl;
else throw new Error(`未知 SLENK_DATA_BACKEND: ${backend}（仅支持 sqlite / mysql）`);

export const initStore = impl.initStore;
export const closeStore = impl.closeStore;

export const ensureAdmin = impl.ensureAdmin;
export const findUserByUsername = impl.findUserByUsername;
export const findUserById = impl.findUserById;
export const createUser = impl.createUser;
export const listUsers = impl.listUsers;
export const updateUser = impl.updateUser;
export const deleteUser = impl.deleteUser;

export const addTask = impl.addTask;
export const listTasks = impl.listTasks;
export const countTasksByType = impl.countTasksByType;
export const listAllTasks = impl.listAllTasks;
export const getTask = impl.getTask;
export const getTaskById = impl.getTaskById;
export const updateTask = impl.updateTask;
export const deleteTask = impl.deleteTask;
export const deleteTaskById = impl.deleteTaskById;
export const deleteTasksByIds = impl.deleteTasksByIds;

export const listProviders = impl.listProviders;
export const getProviderById = impl.getProviderById;
export const getProviderUnmaskedById = impl.getProviderUnmaskedById;
export const getActiveProvider = impl.getActiveProvider;
export const addProvider = impl.addProvider;
export const updateProvider = impl.updateProvider;
export const deleteProvider = impl.deleteProvider;
export const setActiveProvider = impl.setActiveProvider;
export const getActiveProviderIds = impl.getActiveProviderIds;

export const saveNote = impl.saveNote;
export const getNote = impl.getNote;

export const insertMedia = impl.insertMedia;
export const getMedia = impl.getMedia;
export const listMediaIds = impl.listMediaIds;

export const listXhsAccounts = impl.listXhsAccounts;
export const getXhsAccount = impl.getXhsAccount;
export const createXhsAccountPending = impl.createXhsAccountPending;
export const bindXhsAccountOpenId = impl.bindXhsAccountOpenId;
export const findXhsAccountByOpenId = impl.findXhsAccountByOpenId;
export const deleteXhsAccount = impl.deleteXhsAccount;
export const updateXhsAccountNickname = impl.updateXhsAccountNickname;
export const listAllXhsAccounts = impl.listAllXhsAccounts;

export const getAllNotesImagesForJanitor = impl.getAllNotesImagesForJanitor;
export const getAllTasksPayloadForJanitor = impl.getAllTasksPayloadForJanitor;

export const exportSyncRows = impl.exportSyncRows;
export const importSyncRows = impl.importSyncRows;
