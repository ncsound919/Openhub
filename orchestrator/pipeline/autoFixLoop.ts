import { MCPClient } from '../mcp-client.js';
import { ErrorDiagnoser } from '../agents/errorDiagnoser.js';

export class AutoFixLoop {
  private diagnoser: ErrorDiagnoser;

  constructor(private mcpClient: MCPClient) {
    this.diagnoser = new ErrorDiagnoser(mcpClient);
  }

  async run(context: { 
    phase: string; 
    error: { stderr: string; command: string };
    retryFn: () => Promise<any>;
  }, maxAttempts: number = 3): Promise<boolean> {
    console.info(`[AutoFixLoop] Starting loop for ${context.phase}...`);
    
    for (let i = 1; i <= maxAttempts; i++) {
      console.info(`[AutoFixLoop] Attempt ${i}/${maxAttempts}`);
      
      const diagnosis = await this.diagnoser.diagnose(context.error);

      // A diagnosis without a patch is research, not a fix. Writing a
      // placeholder comment over a real file is worse than stopping and
      // letting the caller read the diagnosis.
      if (!diagnosis.fixCode.trim()) {
        console.warn('[AutoFixLoop] Diagnosis had no patch; refusing to write a placeholder.');
        return false;
      }
      
      // Apply the fix using MCP tools
      if (diagnosis.fixStrategy === 'add_dep') {
         await this.mcpClient.callTool('run_install', { manager: 'npm', path: '.' });
      } else {
         // Generic write/replace fix
         await this.mcpClient.callTool('write_file', { 
           path: diagnosis.affectedFile, 
           content: diagnosis.fixCode 
         });
      }
      
      try {
        await context.retryFn();
        console.info(`[AutoFixLoop] Fix successful on attempt ${i}`);
        return true;
      } catch (retryErr: any) {
        console.warn(`[AutoFixLoop] Attempt ${i} failed to resolve error.`);
        context.error = { stderr: retryErr.message, command: context.error.command };
      }
    }
    
    return false;
  }
}
