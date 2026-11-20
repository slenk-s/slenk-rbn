// store.js — 数据层入口：SQLite 唯一后端（MySQL 后端已移除）。
//
// routes / worker / auth / lib 等一律 `import { ... } from './store.js'`。
// SLENK_DATA_BACKEND 仅接受 sqlite（默认，未设置时）；mysql 或任何其他值启动即抛错，
// 避免误配置静默落到错误数据源。
import './loadEnv.js';
import * as impl from './store.sqlite.js';

const backend = process.env.SLENK_DATA_BACKEND || 'sqlite';
if (backend !== 'sqlite') {
  throw new Error(`未知 SLENK_DATA_BACKEND: ${backend}（仅支持 sqlite；MySQL 后端已移除）`);
}

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
