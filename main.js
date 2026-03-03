const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

function createWindow() {
  Menu.setApplicationMenu(null); 

  const win = new BrowserWindow({
    title: "CSV chart viewer",
    width: 1500,
    height: 950,
    show: false,
    icon: path.join(__dirname, 'csv_viewer.ico'), 
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false
    }
  });

  win.loadFile('index.html');

  win.once('ready-to-show', () => {
    win.show();
  });
}

ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  return canceled ? null : filePaths[0];
});

// 파일 저장 다이얼로그 추가
ipcMain.handle('save-dialog', async (event, type) => {
  const ext = type === 'csv' ? 'csv' : 'jpg';
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: `Export ${type.toUpperCase()}`,
    defaultPath: `export_${Date.now()}.${ext}`,
    filters: [{ name: type.toUpperCase(), extensions: [ext] }]
  });
  return canceled ? null : filePath;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
