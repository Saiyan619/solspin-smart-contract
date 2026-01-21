use anchor_lang::prelude::*;
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
    pub system_program: Program<'info, System>
}

#[account]
pub struct GameState{
    player_guess: u64,
    wager: u64,
    vrf_acc: Pubkey,
    bump: u8,
    game_vault: Pubkey,
    max_result: u32,
    commit_slot: u64
}
