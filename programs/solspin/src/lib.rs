use anchor_lang::prelude::*;
use anchor_lang::system_program::{Transfer, transfer};
use switchboard_on_demand::accounts::RandomnessAccountData;

declare_id!("Egeg8KWsUGPMoSE5MnhAto8QrtwenBRQMcgscsQYubuR");
const MAX_RESULTS:u32 = 6;
#[program]
pub mod solspin {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.vrf_acc = Pubkey::default();
        game_state.wager = 0;
        game_state.bump = ctx.bumps.game_state;
        game_state.max_result = MAX_RESULTS;
        game_state.game_vault = ctx.accounts.escrow_vault.key();
        Ok(())
    }

    pub fn call_spin(ctx: Context<CallSpin>, guess:u32, randomness_acc:Pubkey, wager:u64) -> Result<()>{
        let clock = Clock::get()?;
        let game_state = &mut ctx.accounts.game_state;
        game_state.player_guess = guess;
        game_state.wager = wager;
        let random_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_data.data.borrow()
        ).unwrap();
        // Check if the data request is still fresh
        if random_data.seed_slot < clock.slot - 5 {
            return Err(ErrorCode::RandomDataExpired.into());
        }
        // Ensure Random data that is already known and is still in process is not overwritten by rebetting
        if !random_data.get_value(clock.slot).is_err(){
            return Err(ErrorCode::RandomDataAlreadyKnown.into());
        }
        game_state.commit_slot = random_data.seed_slot;

        let game_accounts = Transfer{
            from: ctx.accounts.signer.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info()
        };
        let system_program = ctx.accounts.system_program.to_account_info();
        let cpi_ctx: CpiContext<'_, '_, '_, '_, Transfer<'_>> = CpiContext::new(system_program, game_accounts);
        transfer(cpi_ctx, game_state.wager)?;
        game_state.vrf_acc = randomness_acc;

        msg!("Spinner as been rolled, results have been requested");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info>{
    #[account(init,
        payer=signer,
        space= 8 + std::mem::size_of::<GameState>(),
        seeds = [b"game_state", signer.key().as_ref()],
        bump )]
        pub game_state: Account<'info, GameState>,
        
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: Escrow PDA
    #[account(mut,seeds=[b"escrow_vault"], bump)]
    pub escrow_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>
}

#[derive(Accounts)]
pub struct CallSpin<'info> {
    #[account(mut,
    seeds=[b"game_state", signer.key().as_ref()],
    bump)]
    pub game_state: Account<'info, GameState>,
    /// CHECK: Escrow PDA
    #[account(mut,seeds=[b"escrow_vault"], bump)]
    pub escrow_vault: AccountInfo<'info>,
    /// CHECK: Validated manually in handler
    pub randomness_data: AccountInfo<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>
}

#[account]
pub struct GameState{
    player_guess: u32,
    wager: u64,
    vrf_acc: Pubkey,
    bump: u8,
    game_vault: Pubkey,
    max_result: u32,
    commit_slot: u64
}

#[error_code]
pub enum ErrorCode{
    #[msg("Random data request is expired")]
    RandomDataExpired,
    #[msg("Random data request is already known")]
    RandomDataAlreadyKnown
}